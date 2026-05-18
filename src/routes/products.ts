import { Router } from 'express';
import { PrismaClient, Prisma } from '@prisma/client';
import { getProductDeliveryUrl } from './images';
import { buildOffsetPagination, mapOfferRow, mapOffersToLegacyDetails, RawOfferRow } from '../services/offerMapping';
import { classifyPromotionKind, enrichApiOffersWithPromoContext } from '../services/promoContext';

const router = Router();
const prisma = new PrismaClient();

const CITY_CACHE_TTL_MS = 5 * 60 * 1000;
const SEARCH_CACHE_TTL_MS = 60 * 1000;

type CityCacheEntry = {
  expiresAt: number;
  storeIds: string[];
};

const cityStoreIdsCache = new Map<string, CityCacheEntry>();

async function getCityStoreIdsCached(city: string): Promise<string[]> {
  const key = city.trim().toLowerCase();
  const now = Date.now();
  const cached = cityStoreIdsCache.get(key);
  if (cached && cached.expiresAt > now) return cached.storeIds;

  const stores = await prisma.store.findMany({ where: { city: key }, select: { id: true } });
  const storeIds = stores.map(s => s.id.toString());
  cityStoreIdsCache.set(key, { expiresAt: now + CITY_CACHE_TTL_MS, storeIds });
  return storeIds;
}

type SearchCacheEntry = {
  expiresAt: number;
  payload: {
    products: any[];
    pagination: {
      page: number;
      limit: number;
      total: number;
      totalPages: number;
    };
  };
};

const searchResponseCache = new Map<string, SearchCacheEntry>();

let storePromoCacheCheck: { checkedAt: number; available: boolean } | null = null;

function elapsedMs(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1_000_000;
}

function toServerTiming(timingsMs: Record<string, number>): string {
  return Object.entries(timingsMs)
    .map(([k, v]) => `${k};dur=${v.toFixed(1)}`)
    .join(', ');
}

async function hasStorePromoCache(): Promise<boolean> {
  const now = Date.now();
  if (storePromoCacheCheck && now - storePromoCacheCheck.checkedAt < 60_000) {
    return storePromoCacheCheck.available;
  }

  try {
    const rows = await prisma.$queryRaw<Array<{ available: boolean }>>(Prisma.sql`
      SELECT
        to_regclass('public.product_store_current_promos') IS NOT NULL
        AND COUNT(*) FILTER (
          WHERE column_name IN (
            'product_id',
            'store_id',
            'promo_price',
            'chain_id',
            'promotion_id',
            'promotion_description',
            'promotion_end_date',
            'additional_is_coupon',
            'additional_restrictions',
            'club_id'
          )
        ) = 10 AS available
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'product_store_current_promos'
    `);
    const available = Boolean(rows[0]?.available);
    storePromoCacheCheck = { checkedAt: now, available };
    return available;
  } catch {
    storePromoCacheCheck = { checkedAt: now, available: false };
    return false;
  }
}

router.get('/search', async (req, res) => {
  const tRouteStart = process.hrtime.bigint();
  const timingsMs: Record<string, number> = {};
  try {
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const city = typeof req.query.city === 'string' ? req.query.city.trim() : '';
    const chainId = typeof req.query.chainId === 'string' ? req.query.chainId.trim() : '';
    const storeId = typeof req.query.storeId === 'string' ? req.query.storeId.trim() : '';
    const includeDetailsRaw = typeof req.query.includeDetails === 'string'
      ? req.query.includeDetails.trim().toLowerCase()
      : '';
    const includeDetails = includeDetailsRaw !== ''
      && !(includeDetailsRaw === '0' || includeDetailsRaw === 'false' || includeDetailsRaw === 'no');
    const detailsLimitRaw = Number.parseInt(String(req.query.detailsLimit ?? '1'), 10);
    const detailsLimit = Number.isFinite(detailsLimitRaw) && detailsLimitRaw > 0
      ? Math.min(detailsLimitRaw, 50)
      : 1;
    const limitRaw = Number.parseInt(String(req.query.limit ?? '10'), 10);
    const offsetRaw = Number.parseInt(String(req.query.offset ?? '0'), 10);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : 10;
    const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;
    const hasNarrowStoreFilter = Boolean(chainId || storeId);
    const candidateMultiplier = includeDetails ? 6 : hasNarrowStoreFilter ? 8 : 2;
    const candidateMin = includeDetails ? 60 : hasNarrowStoreFilter ? 60 : limit + 5;
    const candidateMax = includeDetails ? 240 : hasNarrowStoreFilter ? 160 : 30;
    const candidateLimit = Math.min(Math.max(limit * candidateMultiplier, candidateMin), candidateMax);
    const searchTextCandidateLimit = Math.min(Math.max(offset + candidateLimit * 40, 1000), 2000);
    const detailCandidateLimit = includeDetails
      ? Math.min(Math.max(limit * 3, 20), Math.max(limit, candidateLimit))
      : 0;

    if (!query) {
      return res.status(400).json({ error: 'q is required' });
    }
    if (query.length > 200) {
      return res.status(400).json({ error: 'Query too long (max 200 characters)' });
    }

    const searchCacheKey = `search|${query.toLowerCase()}|${city.toLowerCase()}|${chainId}|${storeId}|${includeDetails}|${detailsLimit}|${limit}|${offset}`;
    if (!includeDetails) {
      const cachedSearch = searchResponseCache.get(searchCacheKey);
      if (cachedSearch && cachedSearch.expiresAt > Date.now()) {
        res.setHeader('X-Search-Cache', 'HIT');
        return res.json(cachedSearch.payload);
      }
      res.setHeader('X-Search-Cache', 'MISS');
    }


    type SearchProductRow = {
      product_id: number;
      item_code: string;
      item_name: string | null;
      manufacturer_name: string | null;
      rank: number | null;
      chain_count: number | null;
    };

    const tSearchSql = process.hrtime.bigint();
    let rows = await prisma.$queryRaw<SearchProductRow[]>(Prisma.sql`
      WITH params AS (
        SELECT
          ${query}::text AS raw_query,
          websearch_to_tsquery('simple', ${query}::text) AS tsq
      ),
      fts_candidates AS MATERIALIZED (
        SELECT
          p.id AS product_id,
          p.item_code,
          p.item_name,
          p.manufacturer_name,
          (
            ts_rank(p.search_idx_col, params.tsq)
            + CASE
                WHEN lower(COALESCE(p.item_name, '')) = lower(params.raw_query) THEN 10
                WHEN lower(COALESCE(p.item_name, '')) LIKE lower(params.raw_query) || '%' THEN 6
                WHEN lower(COALESCE(p.item_name, '')) LIKE '% ' || lower(params.raw_query) || '%' THEN 3
                ELSE 0
              END
            + CASE
                WHEN lower(COALESCE(p.manufacturer_name, '')) LIKE lower(params.raw_query) || '%' THEN 0.4
                ELSE 0
              END
          )::real AS text_rank
        FROM products p
        CROSS JOIN params
        WHERE COALESCE(${query}::text, '') <> ''
          AND p.search_idx_col @@ params.tsq
        ORDER BY text_rank DESC NULLS LAST, p.item_code ASC
        LIMIT ${searchTextCandidateLimit}::integer
      )
      SELECT
        c.product_id,
        c.item_code,
        c.item_name,
        c.manufacturer_name,
        (
          c.text_rank
          + (LN(1 + LEAST(COALESCE(pss.chain_count, 0), 40)) * 0.22)
          + (LEAST(COALESCE(pss.chain_count, 0), 25) * 0.03)
        )::real AS rank,
        COALESCE(pss.chain_count, 0)::integer AS chain_count
      FROM fts_candidates c
      LEFT JOIN product_search_stats pss ON pss.product_id = c.product_id
      ORDER BY chain_count DESC NULLS LAST, rank DESC NULLS LAST, item_code ASC
      LIMIT ${candidateLimit}::integer
      OFFSET ${offset}::integer
    `);
    timingsMs.searchSql = elapsedMs(tSearchSql);

    if (rows.length < limit && query.length >= 2) {
      const existingProductIds = rows.map((row) => row.product_id);
      const fallbackLimit = Math.min(Math.max(limit * 3, 30), 80);
      const tFallbackSql = process.hrtime.bigint();
      const fallbackRows = await prisma.$queryRaw<SearchProductRow[]>(Prisma.sql`
        WITH params AS (
          SELECT
            ${query}::text AS raw_query,
            regexp_replace(${query}::text, '\s+', '', 'g') AS compact_query
        ),
        candidate_hits AS (
          SELECT
            p.id,
            p.item_code,
            p.item_name,
            p.manufacturer_name,
            similarity(p.item_name, params.raw_query) AS base_similarity
          FROM products p
          CROSS JOIN params
          WHERE p.item_name % params.raw_query
            ${existingProductIds.length > 0
              ? Prisma.sql`AND p.id <> ALL(${existingProductIds}::int[])`
              : Prisma.empty}
          UNION ALL
          SELECT
            p.id,
            p.item_code,
            p.item_name,
            p.manufacturer_name,
            similarity(p.manufacturer_name, params.raw_query) AS base_similarity
          FROM products p
          CROSS JOIN params
          WHERE p.manufacturer_name % params.raw_query
            ${existingProductIds.length > 0
              ? Prisma.sql`AND p.id <> ALL(${existingProductIds}::int[])`
              : Prisma.empty}
        ),
        ranked_candidates AS (
          SELECT DISTINCT ON (id)
            id,
            item_code,
            item_name,
            manufacturer_name,
            base_similarity
          FROM candidate_hits
          ORDER BY id, base_similarity DESC NULLS LAST
        ),
        candidates AS MATERIALIZED (
          SELECT
            id,
            item_code,
            item_name,
            manufacturer_name
          FROM ranked_candidates
          ORDER BY base_similarity DESC NULLS LAST, item_code ASC
          LIMIT 1000
        )
        SELECT
          c.id AS product_id,
          c.item_code,
          c.item_name,
          c.manufacturer_name,
          (
            GREATEST(
              similarity(COALESCE(c.item_name, ''), params.raw_query),
              similarity(COALESCE(c.manufacturer_name, ''), params.raw_query),
              similarity(regexp_replace(COALESCE(c.item_name, ''), '\s+', '', 'g'), params.compact_query),
              word_similarity(params.raw_query, COALESCE(c.item_name, '')),
              word_similarity(params.raw_query, COALESCE(c.manufacturer_name, ''))
            ) * 3.5
            + CASE
                WHEN lower(COALESCE(c.item_name, '')) LIKE lower(params.raw_query) || '%' THEN 2
                ELSE 0
              END
            + (LN(1 + LEAST(COALESCE(pss.chain_count, 0), 40)) * 0.18)
            + (LEAST(COALESCE(pss.chain_count, 0), 25) * 0.02)
          )::real AS rank,
          COALESCE(pss.chain_count, 0)::integer AS chain_count
        FROM candidates c
        CROSS JOIN params
        LEFT JOIN product_search_stats pss ON pss.product_id = c.id
        ORDER BY chain_count DESC NULLS LAST, rank DESC NULLS LAST, c.item_code ASC
        LIMIT ${fallbackLimit}::integer
      `);
      rows = [...rows, ...fallbackRows];
      timingsMs.fallbackSql = elapsedMs(tFallbackSql);
    }

    const detailsByItemCode = new Map<string, ReturnType<typeof mapOffersToLegacyDetails>>();
    const summaryByItemCode = new Map<string, {
      minPrice: number | null;
      effectivePrice: number | null;
      hasPromo: boolean;
      availableChains: string[];
      promotion: {
        id: string;
        promotion_id: string;
        promotion_description: string | null;
        promotion_start_date: string;
        promotion_end_date: string;
        club_id: null;
        chain_id: string;
        discounted_price: string;
        discount_rate: null;
        min_qty: null;
        max_qty: null;
        available_in_store_ids: string[];
        matched_item_code: string;
        promotion_type: string | null;
        promotion_badge_label: string | null;
        is_conditional_promo: boolean;
      } | null;
    }>();
    let summarySource: 'none' | 'promoCache' | 'live' = 'none';

    if (includeDetails && rows.length > 0) {
      const detailRows = rows.slice(0, detailCandidateLimit || rows.length);
      const itemCodes = detailRows.map((row) => row.item_code);
      const tOffersSql = process.hrtime.bigint();
      const offersRows = await prisma.$queryRaw<RawOfferRow[]>(Prisma.sql`
        WITH input_codes AS (
          SELECT unnest(${itemCodes}::text[]) AS item_code
        )
        SELECT
          o.item_code,
          o.item_name,
          o.manufacturer_name,
          o.chain_id,
          s_name.chain_name,
          o.store_id,
          o.store_name,
          o.city,
          o.price,
          o.promo_price,
          o.effective_price,
          o.unit_of_measure,
          o.unit_qty,
          o.b_is_weighted,
          o.updated_at
        FROM input_codes ic
        CROSS JOIN LATERAL public.get_offers_for_item_code(
          ic.item_code,
          ${city || null}::text,
          ${chainId || null}::text,
          ${detailsLimit}::integer,
          0::integer,
          NULL::text
        ) o
        LEFT JOIN LATERAL (
          SELECT chain_name FROM stores WHERE chain_id = o.chain_id AND store_id = o.store_id LIMIT 1
        ) s_name ON true
        WHERE (${storeId || null}::text IS NULL OR o.store_id = ${storeId || null}::text)
        ORDER BY o.item_code ASC, o.effective_price ASC NULLS LAST, o.updated_at DESC NULLS LAST, o.store_id ASC
      `);
      timingsMs.offersSql = elapsedMs(tOffersSql);

      const tGroupMap = process.hrtime.bigint();
      const mappedOffers = await enrichApiOffersWithPromoContext(
        prisma,
        offersRows.map(mapOfferRow),
      );

      const grouped = new Map<string, ReturnType<typeof mapOfferRow>[]>();
      for (const mapped of mappedOffers) {
        const existing = grouped.get(mapped.itemCode);
        if (existing) {
          existing.push(mapped);
        } else {
          grouped.set(mapped.itemCode, [mapped]);
        }
      }

      for (const [itemCode, offers] of grouped.entries()) {
        detailsByItemCode.set(itemCode, mapOffersToLegacyDetails(offers));
      }
      timingsMs.detailsMap = elapsedMs(tGroupMap);
    } else if (rows.length > 0) {
      type SearchSummaryRow = {
        product_id: number;
        item_code: string;
        min_price: Prisma.Decimal | null;
        min_effective_price: Prisma.Decimal | null;
        has_promo: boolean | null;
        available_chains: string[] | null;
        best_promo_price: Prisma.Decimal | null;
        best_promo_chain_id: string | null;
        best_promo_store_id: string | null;
        best_promo_promotion_id: string | null;
        best_promo_description: string | null;
        best_promo_end_date: Date | string | null;
        best_promo_additional_is_coupon: string | null;
        best_promo_additional_restrictions: string | null;
        best_promo_club_id: string | null;
      };

      const productIds = rows.map((row) => row.product_id);
      const tSummarySql = process.hrtime.bigint();
      const canUseStorePromoCache = await hasStorePromoCache();
      summarySource = canUseStorePromoCache ? 'promoCache' : 'live';
      const promoJoinSql = canUseStorePromoCache
        ? Prisma.sql`
            LEFT JOIN product_store_current_promos pb
              ON pb.product_id = pp.product_id
             AND pb.store_id = pp.store_id
          `
        : Prisma.sql`
            LEFT JOIN LATERAL (
              SELECT MIN(psi.promo_price) AS promo_price
                , (ARRAY_AGG(psi.chain_id ORDER BY psi.promo_price ASC NULLS LAST, psi.updated_at DESC NULLS LAST, psi.promotion_id ASC))[1] AS chain_id
                , (ARRAY_AGG(psi.promotion_id ORDER BY psi.promo_price ASC NULLS LAST, psi.updated_at DESC NULLS LAST, psi.promotion_id ASC))[1] AS promotion_id
                , (ARRAY_AGG(p.promotion_description ORDER BY psi.promo_price ASC NULLS LAST, psi.updated_at DESC NULLS LAST, psi.promotion_id ASC))[1] AS promotion_description
                , (ARRAY_AGG(psi.promotion_end_date ORDER BY psi.promo_price ASC NULLS LAST, psi.updated_at DESC NULLS LAST, psi.promotion_id ASC))[1] AS promotion_end_date
                , (ARRAY_AGG(p.additional_is_coupon ORDER BY psi.promo_price ASC NULLS LAST, psi.updated_at DESC NULLS LAST, psi.promotion_id ASC))[1] AS additional_is_coupon
                , (ARRAY_AGG(p.additional_restrictions ORDER BY psi.promo_price ASC NULLS LAST, psi.updated_at DESC NULLS LAST, psi.promotion_id ASC))[1] AS additional_restrictions
                , (ARRAY_AGG(p.club_id ORDER BY psi.promo_price ASC NULLS LAST, psi.updated_at DESC NULLS LAST, psi.promotion_id ASC))[1] AS club_id
              FROM promotion_store_items psi
              LEFT JOIN promotions p
                ON p.chain_id = psi.chain_id
               AND p.promotion_id = psi.promotion_id
              WHERE psi.product_id = pp.product_id
                AND psi.store_id = pp.store_id
                AND psi.promo_price IS NOT NULL
                AND (psi.promotion_end_date IS NULL OR psi.promotion_end_date >= CURRENT_DATE)
              ) pb ON TRUE
          `;
      const summaryRows = await prisma.$queryRaw<SearchSummaryRow[]>(Prisma.sql`
            WITH selected_products AS (
              SELECT unnest(${productIds}::int[]) AS product_id
            ),
            city_stores AS MATERIALIZED (
              SELECT
                id,
                chain_id,
                store_id,
                COALESCE(NULLIF(chain_name, ''), chain_id)::text AS chain_name
              FROM stores
              WHERE (${city || null}::text IS NULL OR city = ${city || null}::text OR city ILIKE ${city || null}::text || '%')
                AND (${chainId || null}::text IS NULL OR chain_id = ${chainId || null}::text)
                AND (${storeId || null}::text IS NULL OR store_id = ${storeId || null}::text)
            ),
            priced_rows AS (
              SELECT
                sp.product_id,
                p.item_code,
                cs.chain_name,
                cs.chain_id,
                cs.store_id,
                pp.price,
                COALESCE(pb.promo_price, pp.promo_price) AS promo_price,
                COALESCE(pb.chain_id, cs.chain_id) AS promo_chain_id,
                pb.promotion_id,
                pb.promotion_description,
                pb.promotion_end_date,
                pb.additional_is_coupon,
                pb.additional_restrictions,
                pb.club_id,
                LEAST(pp.price, COALESCE(pb.promo_price, pp.promo_price, pp.price)) AS effective_price,
                (
                  COALESCE(pb.promo_price, pp.promo_price) IS NOT NULL
                  AND COALESCE(pb.promo_price, pp.promo_price) < pp.price
                  AND COALESCE(pb.promo_price, pp.promo_price) >= (pp.price * 0.05)
                ) AS has_promo
              FROM selected_products sp
              JOIN products p ON p.id = sp.product_id
              JOIN city_stores cs ON TRUE
              JOIN product_prices pp ON pp.product_id = sp.product_id AND pp.store_id = cs.id
              ${promoJoinSql}
              WHERE pp.price IS NOT NULL
            ),
            chain_rows AS (
              SELECT
                product_id,
                item_code,
                chain_name,
                MIN(price) AS min_price,
                MIN(effective_price) AS min_effective_price,
                BOOL_OR(has_promo) AS has_promo
              FROM priced_rows
              GROUP BY product_id, item_code, chain_name
            ),
            best_promo AS (
              SELECT DISTINCT ON (product_id)
                product_id,
                promo_price AS best_promo_price,
                promo_chain_id AS best_promo_chain_id,
                store_id AS best_promo_store_id,
                promotion_id AS best_promo_promotion_id,
                promotion_description AS best_promo_description,
                promotion_end_date AS best_promo_end_date,
                additional_is_coupon AS best_promo_additional_is_coupon,
                additional_restrictions AS best_promo_additional_restrictions,
                club_id AS best_promo_club_id
              FROM priced_rows
              WHERE promo_price IS NOT NULL
                AND price IS NOT NULL
                AND promo_price < price
                AND promo_price >= (price * 0.05)
              ORDER BY product_id, promo_price ASC NULLS LAST, price DESC NULLS LAST
            )
            SELECT
              cr.product_id,
              cr.item_code,
              MIN(cr.min_price) AS min_price,
              MIN(cr.min_effective_price) AS min_effective_price,
              BOOL_OR(cr.has_promo) AS has_promo,
              ARRAY_AGG(cr.chain_name ORDER BY cr.chain_name) FILTER (WHERE cr.chain_name IS NOT NULL) AS available_chains,
              bp.best_promo_price,
              bp.best_promo_chain_id,
              bp.best_promo_store_id,
              bp.best_promo_promotion_id,
              bp.best_promo_description,
              bp.best_promo_end_date,
              bp.best_promo_additional_is_coupon,
              bp.best_promo_additional_restrictions,
              bp.best_promo_club_id
            FROM chain_rows cr
            LEFT JOIN best_promo bp ON bp.product_id = cr.product_id
            GROUP BY
              cr.product_id,
              cr.item_code,
              bp.best_promo_price,
              bp.best_promo_chain_id,
              bp.best_promo_store_id,
              bp.best_promo_promotion_id,
              bp.best_promo_description,
              bp.best_promo_end_date,
              bp.best_promo_additional_is_coupon,
              bp.best_promo_additional_restrictions,
              bp.best_promo_club_id
          `);
      timingsMs.summarySql = elapsedMs(tSummarySql);

      for (const row of summaryRows) {
        const hasBestPromo = row.best_promo_price !== null
          && row.best_promo_chain_id
          && row.best_promo_store_id;
        const classifiedPromo = hasBestPromo
          ? classifyPromotionKind({
              promotion_description: row.best_promo_description,
              additional_is_coupon: row.best_promo_additional_is_coupon,
              additional_restrictions: row.best_promo_additional_restrictions,
              club_id: row.best_promo_club_id,
            })
          : null;

        summaryByItemCode.set(row.item_code, {
          minPrice: row.min_price !== null ? Number(row.min_price) : null,
          effectivePrice: row.min_effective_price !== null ? Number(row.min_effective_price) : null,
          hasPromo: Boolean(row.has_promo),
          availableChains: row.available_chains ?? [],
          promotion: hasBestPromo && classifiedPromo
            ? {
                id: `${row.item_code}-${row.best_promo_store_id}-summary-promo`,
                promotion_id: row.best_promo_promotion_id ?? `promo-${row.best_promo_chain_id}-${row.best_promo_store_id}`,
                promotion_description: row.best_promo_description,
                promotion_start_date: '1970-01-01',
                promotion_end_date: row.best_promo_end_date
                  ? new Date(row.best_promo_end_date).toISOString().slice(0, 10)
                  : '2999-12-31',
                club_id: null,
                chain_id: row.best_promo_chain_id!,
                discounted_price: row.best_promo_price!.toString(),
                discount_rate: null,
                min_qty: null,
                max_qty: null,
                available_in_store_ids: [row.best_promo_store_id!],
                matched_item_code: row.item_code,
                promotion_type: classifiedPromo.promoKind,
                promotion_badge_label: classifiedPromo.promoLabel,
                is_conditional_promo: classifiedPromo.isConditionalPromo,
              }
            : null,
        });
      }
    }

    const tResponseMap = process.hrtime.bigint();
    const mappedProducts = rows.map((row) => ({
      imageUrl: getProductDeliveryUrl(row.item_code),
      ...(detailsByItemCode.get(row.item_code)
        ? {
            prices: detailsByItemCode.get(row.item_code)!.prices,
            promotions: detailsByItemCode.get(row.item_code)!.promotions,
            detailsLoaded: true,
            hasPromo: detailsByItemCode.get(row.item_code)!.hasPromo,
            minPrice: detailsByItemCode.get(row.item_code)!.bestPrice !== null
              ? String(detailsByItemCode.get(row.item_code)!.bestPrice)
              : null,
            effectivePrice: detailsByItemCode.get(row.item_code)!.bestEffectivePrice !== null
              ? String(detailsByItemCode.get(row.item_code)!.bestEffectivePrice)
              : null,
          }
        : summaryByItemCode.get(row.item_code)
        ? {
            prices: [],
            promotions: summaryByItemCode.get(row.item_code)!.promotion
              ? [summaryByItemCode.get(row.item_code)!.promotion!]
              : [],
            detailsLoaded: false,
            hasPromo: summaryByItemCode.get(row.item_code)!.hasPromo,
            minPrice: summaryByItemCode.get(row.item_code)!.minPrice !== null
              ? String(summaryByItemCode.get(row.item_code)!.minPrice)
              : null,
            effectivePrice: summaryByItemCode.get(row.item_code)!.effectivePrice !== null
              ? String(summaryByItemCode.get(row.item_code)!.effectivePrice)
              : null,
            availableChains: summaryByItemCode.get(row.item_code)!.availableChains,
          }
        : {
            prices: [],
            promotions: [],
            detailsLoaded: false,
          }),
      itemCode: row.item_code,
      itemName: row.item_name,
      manufacturerName: row.manufacturer_name,
      rank: row.rank,
      chainCount: row.chain_count,
    }));

    const filteredProducts = mappedProducts
      .filter((product) => includeDetails
        ? product.detailsLoaded && product.prices.length > 0
        : summaryByItemCode.has(product.itemCode))
      .slice(0, limit);
    timingsMs.responseMap = elapsedMs(tResponseMap);
    timingsMs.total = elapsedMs(tRouteStart);
    res.setHeader('Server-Timing', toServerTiming(timingsMs));

    // Fix: Convert any BigInt values in timingsMs to Number for logging
    const safeTimingsMs = Object.fromEntries(
      Object.entries(timingsMs).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v])
    );

    // Also ensure no BigInt in products or pagination
    function safeJson(obj: any): any {
      if (Array.isArray(obj)) return obj.map(safeJson);
      if (obj && typeof obj === 'object') {
        const out: { [key: string]: any } = {};
        for (const [k, v] of Object.entries(obj)) {
          if (typeof v === 'bigint') out[k] = Number(v);
          else out[k] = safeJson(v);
        }
        return out;
      }
      return obj;
    }

    console.info('perf.products.search', {
      query,
      city: city || null,
      chainId: chainId || null,
      storeId: storeId || null,
      includeDetails,
      detailsLimit,
      detailCandidateLimit,
      candidateLimit,
      limit,
      offset,
      rowCount: rows.length,
      filteredCount: filteredProducts.length,
      summarySource,
      timingsMs: safeTimingsMs,
    });

    const payload = {
      products: safeJson(filteredProducts),
      pagination: safeJson(buildOffsetPagination(limit, offset, filteredProducts.length)),
    };

    if (!includeDetails) {
      searchResponseCache.set(searchCacheKey, {
        expiresAt: Date.now() + SEARCH_CACHE_TTL_MS,
        payload,
      });
    }

    return res.json(payload);
  } catch (error) {
    // Log détaillé pour diagnostiquer l'erreur Prisma
    if (error instanceof Error) {
      // PrismaClientKnownRequestError a des propriétés code, meta, clientVersion
      // On log tout ce qu'on peut
      // @ts-ignore
      const code = error.code || '';
      // @ts-ignore
      const meta = error.meta || {};
      // @ts-ignore
      const clientVersion = error.clientVersion || '';
      console.error('[products.search] Prisma error:', {
        message: error.message,
        stack: error.stack,
        code,
        meta,
        clientVersion,
        errorObj: error,
      });
    } else {
      console.error('products.search unknown error:', error);
    }
    return res.status(500).json({ error: 'Internal server error' });
  }
});

function parseItemCodesQuery(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  return raw
    .split(',')
    .map(v => v.trim())
    .filter(Boolean)
    .slice(0, 50);
}

function parsePositiveInt(raw: unknown, fallback: number): number {
  const val = parseInt(String(raw ?? ''), 10);
  return Number.isFinite(val) && val > 0 ? val : fallback;
}

// ─── Helper: fetch stores for a set of store DB IDs ─────────────────────────
// Note: we do NOT filter by city here — city is used only for sort priority.
// Filtering by city in the DB would silently drop all prices if the city name
// doesn't match exactly, leaving the user with no data.
async function getStoreMap(storeIds: number[]) {
  const stores = await prisma.store.findMany({
    where: { id: { in: storeIds } },
    select: { id: true, chainId: true, storeId: true, chainName: true, storeName: true, city: true },
  });
  return new Map(stores.map(s => [s.id.toString(), s]));
}

// ─── Helper: expand price.storePrices JSON into per-store price objects ───────
function expandPrices(prices: any[], storeMap: Map<string, any>): any[] {
  const result: any[] = [];
  for (const price of prices) {
    const sp = (price.storePrices || {}) as Record<string, number>;
    for (const [storeDbId, storePrice] of Object.entries(sp)) {
      const store = storeMap.get(storeDbId);
      if (!store) continue;
      result.push({
        id: `${price.id}-${storeDbId}`,
        priceRowId: price.id,
        chainId: price.chainId,
        itemCode: price.itemCode,
        itemPrice: String(storePrice),
        basePrice: price.basePrice,
        priceUpdateDate: price.priceUpdateDate,
        unitOfMeasure: price.unitOfMeasure,
        unitQty: price.unitQty,
        bIsWeighted: price.bIsWeighted,
        store,
      });
    }
  }
  return result;
}

router.get('/search/fast', async (req, res) => {
  try {
    const tRouteStart = process.hrtime.bigint();
    const { q, page = '1', limit = '10', city } = req.query;

    if (!q || typeof q !== 'string') {
      return res.status(400).json({ error: 'Query parameter required' });
    }
    if (q.length > 200) {
      return res.status(400).json({ error: 'Query too long (max 200 characters)' });
    }

    const pageNum = Math.max(parsePositiveInt(page, 1), 1);
    const limitNum = Math.min(Math.max(parsePositiveInt(limit, 10), 1), 10);
    const requestedFastLimit = parsePositiveInt(req.query.fastLimit, limitNum);
    const fastLimitNum = Math.max(1, Math.min(requestedFastLimit, limitNum));
    const effectiveLimit = fastLimitNum;
    const isVisiblePhase = effectiveLimit < limitNum;
    const enableFuzzy = !isVisiblePhase;
    const offsetNum = (pageNum - 1) * limitNum;
    const queryText = q.trim();
    const cityText = typeof city === 'string' ? city.trim() : '';
    const fuzzyThreshold = Math.max(3, Math.floor(effectiveLimit / 2));
    const timingsMs: Record<string, number> = {};
    const markStart = () => process.hrtime.bigint();
    const markEnd = (label: string, start: bigint) => {
      timingsMs[label] = Number(process.hrtime.bigint() - start) / 1_000_000;
    };

    if (!queryText) {
      return res.json({
        products: [],
        pagination: {
          page: pageNum,
          limit: limitNum,
          total: 0,
          totalPages: 0,
        },
      });
    }

    const searchCacheKey = `fast|${queryText}|${cityText}|${pageNum}|${limitNum}|${effectiveLimit}`;
    const cachedSearch = searchResponseCache.get(searchCacheKey);
    if (cachedSearch && cachedSearch.expiresAt > Date.now()) {
      res.setHeader('X-Search-Cache', 'HIT');
      return res.json(cachedSearch.payload);
    }
    res.setHeader('X-Search-Cache', 'MISS');

    const tCityLookup = markStart();
    const cityStoreIdStrings = cityText ? await getCityStoreIdsCached(cityText) : [];
    markEnd('cityLookup', tCityLookup);

    if (cityText && cityStoreIdStrings.length === 0) {
      return res.json({
        products: [],
        pagination: {
          page: pageNum,
          limit: limitNum,
          total: 0,
          totalPages: 0,
        },
      });
    }

    const cityItemsCte = cityText
      ? Prisma.sql`,
      city_items AS (
        SELECT DISTINCT pr.item_code
        FROM prices pr
        WHERE pr.available_in_store_ids && ${cityStoreIdStrings}::text[]
      )`
      : Prisma.empty;

    const cityJoin = cityText
      ? Prisma.sql`JOIN city_items ci ON ci.item_code = p.item_code`
      : Prisma.empty;

    type FastSearchRow = {
      itemCode: string;
      itemName: string | null;
      manufacturerName: string | null;
      rank: number;
    };

    const tSearchCore = markStart();
    const rows = await prisma.$queryRaw<FastSearchRow[]>(Prisma.sql`
      WITH params AS (
        SELECT websearch_to_tsquery('simple', ${queryText}) AS tsq, ${queryText}::text AS raw_query
      )
      ${cityItemsCte},
      fts AS (
        SELECT
          p.item_code,
          ts_rank(p.search_idx_col, params.tsq) AS rank,
          TRUE AS is_fts
        FROM products p
        CROSS JOIN params
        ${cityJoin}
        WHERE p.search_idx_col @@ params.tsq
        ORDER BY rank DESC
        LIMIT ${effectiveLimit * 2}
      ),
      fts_count AS (
        SELECT COUNT(*)::int AS total FROM fts
      ),
      fuzzy AS (
        SELECT
          p.item_code,
          GREATEST(
            similarity(COALESCE(p.item_name, ''), params.raw_query),
            similarity(COALESCE(p.manufacturer_name, ''), params.raw_query)
          ) * 0.5 AS rank,
          FALSE AS is_fts
        FROM products p
        CROSS JOIN params
        CROSS JOIN fts_count c
        ${cityJoin}
        WHERE ${enableFuzzy}
          AND c.total < ${fuzzyThreshold}
          AND (
            COALESCE(p.item_name, '') % params.raw_query
            OR COALESCE(p.manufacturer_name, '') % params.raw_query
          )
          AND NOT EXISTS (
            SELECT 1
            FROM fts
            WHERE fts.item_code = p.item_code
          )
        ORDER BY rank DESC
        LIMIT ${limitNum}
      ),
      candidates AS (
        SELECT * FROM fts
        UNION ALL
        SELECT * FROM fuzzy
      ),
      dedup AS (
        SELECT DISTINCT ON (item_code)
          item_code,
          rank
        FROM candidates
        ORDER BY item_code, is_fts DESC, rank DESC
      )
      SELECT
        p.item_code AS "itemCode",
        p.item_name AS "itemName",
        p.manufacturer_name AS "manufacturerName",
        d.rank AS "rank"
      FROM dedup d
      JOIN products p ON p.item_code = d.item_code
      ORDER BY d.rank DESC, p.item_name ASC
      LIMIT ${effectiveLimit}
      OFFSET ${offsetNum}
    `);
    markEnd('searchCore', tSearchCore);

    const itemCodes = rows.map(r => r.itemCode);
    const cityStoreIdNums = cityStoreIdStrings
      .map(id => parseInt(id, 10))
      .filter(n => !Number.isNaN(n));
    const priceCityFilter = cityText
      ? Prisma.sql`AND s.id = ANY(${cityStoreIdNums}::int[])`
      : Prisma.empty;

    type FastPriceAggRow = {
      itemCode: string;
      chainName: string | null;
      itemPrice: Prisma.Decimal;
    };

    const tMinPriceAgg = markStart();
    const priceAggRows = itemCodes.length > 0
      ? await prisma.$queryRaw<FastPriceAggRow[]>(Prisma.sql`
          SELECT
            pr.item_code AS "itemCode",
            s.chain_name AS "chainName",
            e.value::numeric AS "itemPrice"
          FROM prices pr
          CROSS JOIN LATERAL jsonb_each_text(pr.store_prices::jsonb) AS e(key, value)
          JOIN stores s ON s.id = e.key::int
          WHERE pr.item_code = ANY(${itemCodes})
            AND e.key ~ '^[0-9]+$'
            AND e.value ~ '^\\s*[0-9]+(\\.[0-9]+)?\\s*$'
            ${priceCityFilter}
        `)
      : [];
    markEnd('minPriceAgg', tMinPriceAgg);

    type FastPromoAggRow = {
      itemCode: string;
      discountedPrice: string | null;
    };

    const now = new Date();
    const tPromoAgg = markStart();
    const promoCityFilter = cityText
      ? Prisma.sql`AND p.available_in_store_ids && ${cityStoreIdStrings}::text[]`
      : Prisma.empty;

    const promoAggRows = itemCodes.length > 0
      ? await prisma.$queryRaw<FastPromoAggRow[]>(Prisma.sql`
          SELECT
            pi.item_code AS "itemCode",
            COALESCE(p.discounted_price, pi.discounted_price::text) AS "discountedPrice"
          FROM promotions p
          JOIN promotion_items pi ON pi.promotion_db_id = p.id
          WHERE pi.item_code = ANY(${itemCodes})
            AND p.promotion_start_date <= ${now}
            AND p.promotion_end_date >= ${now}
            AND (p.club_id IS NULL OR p.club_id != '2')
            ${promoCityFilter}
        `)
      : [];
    markEnd('promoAgg', tPromoAgg);

    const tChainAgg = markStart();
    const priceStatsByCode = new Map<string, { minPrice: number | null; chains: Set<string> }>();
    for (const row of rows) {
      priceStatsByCode.set(row.itemCode, { minPrice: null, chains: new Set<string>() });
    }
    for (const pr of priceAggRows) {
      const itemStats = priceStatsByCode.get(pr.itemCode);
      if (!itemStats) continue;
      const numericPrice = Number(pr.itemPrice);
      if (Number.isFinite(numericPrice)) {
        if (itemStats.minPrice === null || numericPrice < itemStats.minPrice) {
          itemStats.minPrice = numericPrice;
        }
      }
      if (pr.chainName) itemStats.chains.add(pr.chainName);
    }

    const minDiscountByCode = new Map<string, number | null>();
    for (const code of itemCodes) minDiscountByCode.set(code, null);
    for (const promo of promoAggRows) {
      const num = promo.discountedPrice ? parseFloat(promo.discountedPrice) : NaN;
      if (!Number.isFinite(num)) continue;
      const current = minDiscountByCode.get(promo.itemCode);
      if (current === null || current === undefined || num < current) {
        minDiscountByCode.set(promo.itemCode, num);
      }
    }
    markEnd('chainAgg', tChainAgg);

    const tImageLookup = markStart();
    const imageMap = Object.fromEntries(
      itemCodes.map((code) => [code, getProductDeliveryUrl(code)])
    );
    markEnd('imageLookup', tImageLookup);

    const products = rows.map(row => {
      const stats = priceStatsByCode.get(row.itemCode) ?? { minPrice: null, chains: new Set<string>() };
      const minDiscountedPrice = minDiscountByCode.get(row.itemCode) ?? null;
      const effectivePrice = minDiscountedPrice ?? stats.minPrice;
      return {
        itemCode: row.itemCode,
        itemName: row.itemName,
        manufacturerName: row.manufacturerName,
        rank: row.rank,
        hasPromo: minDiscountedPrice !== null,
        minPrice: stats.minPrice !== null ? String(stats.minPrice) : null,
        minDiscountedPrice: minDiscountedPrice !== null ? String(minDiscountedPrice) : null,
        effectivePrice: effectivePrice !== null ? String(effectivePrice) : null,
        availableChains: Array.from(stats.chains),
        imageUrl: imageMap[row.itemCode] ?? null,
        prices: [],
        promotions: [],
        detailsLoaded: false,
      };
    });

    timingsMs.total = Number(process.hrtime.bigint() - tRouteStart) / 1_000_000;
    res.setHeader(
      'Server-Timing',
      Object.entries(timingsMs)
        .map(([k, v]) => `${k};dur=${v.toFixed(1)}`)
        .join(', ')
    );
    console.info('products.search.fast.timing', {
      q: queryText,
      city: cityText || null,
      page: pageNum,
      limit: limitNum,
      fastLimit: effectiveLimit,
      fuzzyEnabled: enableFuzzy,
      resultCount: products.length,
      timingsMs,
    });

    const payload = {
      products,
      pagination: {
        page: pageNum,
        limit: limitNum,
        fastLimit: effectiveLimit,
        total: products.length,
        totalPages: products.length === 0 ? 0 : 1,
      },
    };

    searchResponseCache.set(searchCacheKey, {
      expiresAt: Date.now() + SEARCH_CACHE_TTL_MS,
      payload,
    });

    return res.json(payload);
  } catch (error) {
    console.error('Fast search error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/search/details', async (req, res) => {
  try {
    const itemCodes = parseItemCodesQuery(req.query.itemCodes);
    const cityText = typeof req.query.city === 'string' ? req.query.city.trim() : '';
    const chainId = typeof req.query.chainId === 'string' ? req.query.chainId.trim() : '';
    const storeId = typeof req.query.storeId === 'string' ? req.query.storeId.trim() : '';
    if (itemCodes.length === 0) {
      return res.json({ details: {} });
    }

    const offersRows = await prisma.$queryRaw<RawOfferRow[]>(Prisma.sql`
      WITH input_codes AS (
        SELECT unnest(${itemCodes}::text[]) AS item_code
      )
      SELECT
        o.item_code,
        o.item_name,
        o.manufacturer_name,
        o.chain_id,
        s_name.chain_name,
        o.store_id,
        o.store_name,
        o.city,
        o.price,
        o.promo_price,
        o.effective_price,
        o.unit_of_measure,
        o.unit_qty,
        o.b_is_weighted,
        o.updated_at
      FROM input_codes ic
      CROSS JOIN LATERAL public.get_offers_for_item_code(
        ic.item_code,
        ${cityText || null}::text,
        ${chainId || null}::text,
        100::integer,
        0::integer,
        NULL::text
      ) o
      LEFT JOIN LATERAL (
        SELECT chain_name FROM stores WHERE chain_id = o.chain_id AND store_id = o.store_id LIMIT 1
      ) s_name ON true
      WHERE (${storeId || null}::text IS NULL OR o.store_id = ${storeId || null}::text)
      ORDER BY o.item_code ASC, o.effective_price ASC NULLS LAST, o.updated_at DESC NULLS LAST, o.store_id ASC
    `);

    const mappedOffers = await enrichApiOffersWithPromoContext(
      prisma,
      offersRows.map(mapOfferRow),
    );

    const grouped = new Map<string, ReturnType<typeof mapOfferRow>[]>();
    for (const mapped of mappedOffers) {
      const existing = grouped.get(mapped.itemCode);
      if (existing) {
        existing.push(mapped);
      } else {
        grouped.set(mapped.itemCode, [mapped]);
      }
    }

    const details = Object.fromEntries(
      itemCodes.map((code) => {
        const groupedOffers = grouped.get(code) ?? [];
        const mapped = mapOffersToLegacyDetails(groupedOffers);
        return [code, {
          prices: mapped.prices,
          promotions: mapped.promotions,
          detailsLoaded: true,
          hasPromo: mapped.hasPromo,
          minPrice: mapped.bestPrice !== null ? String(mapped.bestPrice) : null,
          effectivePrice: mapped.bestEffectivePrice !== null ? String(mapped.bestEffectivePrice) : null,
        }];
      })
    );

    return res.json({ details });
  } catch (error) {
    console.error('Search details error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/search/stream', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  return res.status(404).json({ error: 'Not found' });
});

// Lightweight product picker search for cart/list flows.
// Intentionally returns only the fields those UIs need, so `/search`
// can keep its richer response without paying that cost here.
router.get('/search-lite', async (req, res) => {
  try {
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const limitRaw = Number.parseInt(String(req.query.limit ?? '12'), 10);
    const offsetRaw = Number.parseInt(String(req.query.offset ?? '0'), 10);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 30) : 12;
    const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;

    if (!query) return res.status(400).json({ error: 'q is required' });
    if (query.length > 200) return res.status(400).json({ error: 'Query too long (max 200 characters)' });

    type LiteRow = {
      product_id: number;
      item_code: string;
      item_name: string | null;
      manufacturer_name: string | null;
      rank: number | null;
      chain_count: number | null;
    };

    const fetchLimit = limit + 1;
    let rows: LiteRow[];

    if (query.length === 1) {
      rows = await prisma.$queryRaw<LiteRow[]>(Prisma.sql`
        SELECT
          p.id AS product_id,
          p.item_code,
          p.item_name,
          p.manufacturer_name,
          0::real AS rank,
          COALESCE(pss.chain_count, 0)::integer AS chain_count
        FROM products p
        LEFT JOIN product_search_stats pss ON pss.product_id = p.id
        WHERE lower(COALESCE(p.item_name, '')) LIKE lower(${query}) || '%'
           OR lower(COALESCE(p.manufacturer_name, '')) LIKE lower(${query}) || '%'
        ORDER BY chain_count DESC NULLS LAST, p.item_name ASC NULLS LAST, p.item_code ASC
        LIMIT ${fetchLimit}::integer
        OFFSET ${offset}::integer
      `);
    } else {
      rows = await prisma.$queryRaw<LiteRow[]>(Prisma.sql`
        WITH params AS (
          SELECT
            ${query}::text AS raw_query,
            websearch_to_tsquery('simple', ${query}::text) AS tsq
        ),
        fts_candidates AS MATERIALIZED (
          SELECT
            p.id AS product_id,
            p.item_code,
            p.item_name,
            p.manufacturer_name,
            (
              ts_rank(p.search_idx_col, params.tsq)
              + CASE
                  WHEN lower(COALESCE(p.item_name, '')) = lower(params.raw_query) THEN 10
                  WHEN lower(COALESCE(p.item_name, '')) LIKE lower(params.raw_query) || '%' THEN 6
                  WHEN lower(COALESCE(p.item_name, '')) LIKE '% ' || lower(params.raw_query) || '%' THEN 3
                  ELSE 0
                END
            )::real AS text_rank
          FROM products p
          CROSS JOIN params
          WHERE p.search_idx_col @@ params.tsq
          ORDER BY text_rank DESC NULLS LAST, p.item_code ASC
          LIMIT 300
        )
        SELECT
          c.product_id,
          c.item_code,
          c.item_name,
          c.manufacturer_name,
          c.text_rank AS rank,
          COALESCE(pss.chain_count, 0)::integer AS chain_count
        FROM fts_candidates c
        LEFT JOIN product_search_stats pss ON pss.product_id = c.product_id
        ORDER BY chain_count DESC NULLS LAST, rank DESC NULLS LAST, item_code ASC
        LIMIT ${fetchLimit}::integer
        OFFSET ${offset}::integer
      `);

      if (rows.length < fetchLimit) {
        const existingProductIds = rows.map((row) => row.product_id);
        const fallbackRows = await prisma.$queryRaw<LiteRow[]>(Prisma.sql`
          WITH params AS (
            SELECT
              ${query}::text AS raw_query,
              regexp_replace(${query}::text, '\s+', '', 'g') AS compact_query
          ),
          ranked_candidates AS (
            SELECT DISTINCT ON (p.id)
              p.id,
              p.item_code,
              p.item_name,
              p.manufacturer_name,
              GREATEST(
                similarity(COALESCE(p.item_name, ''), params.raw_query),
                similarity(COALESCE(p.manufacturer_name, ''), params.raw_query),
                similarity(regexp_replace(COALESCE(p.item_name, ''), '\s+', '', 'g'), params.compact_query),
                word_similarity(params.raw_query, COALESCE(p.item_name, ''))
              ) AS base_similarity
            FROM products p
            CROSS JOIN params
            WHERE (
              p.item_name % params.raw_query
              OR p.manufacturer_name % params.raw_query
            )
            ${existingProductIds.length > 0
              ? Prisma.sql`AND p.id <> ALL(${existingProductIds}::int[])`
              : Prisma.empty}
            ORDER BY p.id, base_similarity DESC NULLS LAST
          )
          SELECT
            c.id AS product_id,
            c.item_code,
            c.item_name,
            c.manufacturer_name,
            c.base_similarity::real AS rank,
            COALESCE(pss.chain_count, 0)::integer AS chain_count
          FROM ranked_candidates c
          LEFT JOIN product_search_stats pss ON pss.product_id = c.id
          ORDER BY chain_count DESC NULLS LAST, rank DESC NULLS LAST, item_code ASC
          LIMIT ${Math.max(0, fetchLimit - rows.length)}::integer
        `);
        rows = [...rows, ...fallbackRows];
      }
    }

    const pageRows = rows.slice(0, limit);
    const hasMore = rows.length > limit;

    return res.json({
      products: pageRows.map((row) => ({
        itemCode: row.item_code,
        itemName: row.item_name,
        imageUrl: getProductDeliveryUrl(row.item_code),
      })),
      pagination: {
        limit,
        offset,
        nextOffset: hasMore ? offset + limit : null,
        hasMore,
      },
    });
  } catch (error) {
    console.error('[products.search-lite] error', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/products/search ────────────────────────────────────────────────
// router.get('/search', async (req, res) => {
//   try {
//     const tRouteStart = process.hrtime.bigint();
//     const { q, page = '1', limit = '10', city } = req.query;

//     if (!q || typeof q !== 'string') {
//       return res.status(400).json({ error: 'Query parameter required' });
//     }

//     const pageNum = Math.max(parseInt(page as string) || 1, 1);
//     const limitNum = Math.min(Math.max(parseInt(limit as string) || 10, 1), 10);
//     const offsetNum = (pageNum - 1) * limitNum;
//     const queryText = q.trim();
//     const cityText = typeof city === 'string' ? city.trim() : '';
//     const fuzzyThreshold = Math.max(3, Math.floor(limitNum / 2));
//     const timingsMs: Record<string, number> = {};
//     const markStart = () => process.hrtime.bigint();
//     const markEnd = (label: string, start: bigint) => {
//       timingsMs[label] = Number(process.hrtime.bigint() - start) / 1_000_000;
//     };

//     if (!queryText) {
//       return res.json({
//         products: [],
//         pagination: {
//           page: pageNum,
//           limit: limitNum,
//           total: 0,
//           totalPages: 0,
//         },
//       });
//     }

//     const searchCacheKey = `${queryText}|${cityText}|${pageNum}|${limitNum}`;
//     const cachedSearch = searchResponseCache.get(searchCacheKey);
//     if (cachedSearch && cachedSearch.expiresAt > Date.now()) {
//       res.setHeader('X-Search-Cache', 'HIT');
//       return res.json(cachedSearch.payload);
//     }
//     res.setHeader('X-Search-Cache', 'MISS');

//     const tCityLookup = markStart();
//     const cityStoreIdStrings = cityText ? await getCityStoreIdsCached(cityText) : [];
//     const cityStoreIdSet = new Set(cityStoreIdStrings);
//     markEnd('cityLookup', tCityLookup);

//     // Strict city mode: if no stores match the requested city, return no products.
//     if (cityText && cityStoreIdStrings.length === 0) {
//       return res.json({
//         products: [],
//         pagination: {
//           page: pageNum,
//           limit: limitNum,
//           total: 0,
//           totalPages: 0,
//         },
//       });
//     }

//     const cityProductFilter = cityText
//       ? Prisma.sql`
//           AND EXISTS (
//             SELECT 1
//             FROM prices pr
//             WHERE pr.item_code = p.item_code
//               AND pr.available_in_store_ids && ${cityStoreIdStrings}::text[]
//           )
//         `
//       : Prisma.empty;

//     type ProductSearchRow = {
//       itemCode: string;
//       itemName: string | null;
//       manufacturerName: string | null;
//       manufactureCountry: string | null;
//       rank: number;
//     };

//     const tSearchQuery = markStart();
//     const rows = await prisma.$queryRaw<ProductSearchRow[]>(Prisma.sql`
//       WITH params AS (
//         SELECT websearch_to_tsquery('simple', ${queryText}) AS tsq, ${queryText}::text AS raw_query
//       ),
//       fts AS (
//         SELECT
//           p.item_code,
//           ts_rank(p.search_idx_col, params.tsq) AS rank,
//           TRUE AS is_fts
//         FROM products p
//         CROSS JOIN params
//         WHERE p.search_idx_col @@ params.tsq
//           ${cityProductFilter}
//         ORDER BY rank DESC
//         LIMIT ${limitNum * 2}
//       ),
//       fts_count AS (
//         SELECT COUNT(*)::int AS total FROM fts
//       ),
//       fuzzy AS (
//         SELECT
//           p.item_code,
//           GREATEST(
//             similarity(COALESCE(p.item_name, ''), params.raw_query),
//             similarity(COALESCE(p.manufacturer_name, ''), params.raw_query)
//           ) * 0.5 AS rank,
//           FALSE AS is_fts
//         FROM products p
//         CROSS JOIN params
//         CROSS JOIN fts_count c
//         WHERE c.total < ${fuzzyThreshold}
//           ${cityProductFilter}
//           AND (
//             COALESCE(p.item_name, '') % params.raw_query
//             OR COALESCE(p.manufacturer_name, '') % params.raw_query
//           )
//           AND NOT EXISTS (
//             SELECT 1
//             FROM fts
//             WHERE fts.item_code = p.item_code
//           )
//         ORDER BY rank DESC
//         LIMIT ${limitNum}
//       ),
//       candidates AS (
//         SELECT * FROM fts
//         UNION ALL
//         SELECT * FROM fuzzy
//       ),
//       dedup AS (
//         SELECT DISTINCT ON (item_code)
//           item_code,
//           rank
//         FROM candidates
//         ORDER BY item_code, is_fts DESC, rank DESC
//       ),
//       ranked AS (
//         SELECT
//           d.item_code,
//           d.rank
//         FROM dedup d
//       )
//       SELECT
//         p.item_code AS "itemCode",
//         p.item_name AS "itemName",
//         p.manufacturer_name AS "manufacturerName",
//         p.manufacture_country AS "manufactureCountry",
//         r.rank AS "rank"
//       FROM ranked r
//       JOIN products p ON p.item_code = r.item_code
//       ORDER BY r.rank DESC, p.item_name ASC
//       LIMIT ${limitNum}
//       OFFSET ${offsetNum}
//     `);
//     markEnd('searchQuery', tSearchQuery);

//     const itemCodes = rows.map(r => r.itemCode);

//     type PriceExpandedRow = {
//       priceId: number;
//       chainId: string;
//       itemCode: string;
//       itemPrice: Prisma.Decimal;
//       basePrice: string | null;
//       priceUpdateDate: Date | null;
//       unitOfMeasure: string | null;
//       unitQty: string | null;
//       bIsWeighted: boolean | null;
//       storeDbId: number;
//       storeChainId: string;
//       storeId: string;
//       chainName: string | null;
//       storeName: string | null;
//       city: string | null;
//     };

//     const cityStoreIdNums = cityStoreIdStrings
//       .map(id => parseInt(id, 10))
//       .filter(n => !Number.isNaN(n));
//     const priceCityFilter = cityText
//       ? Prisma.sql`AND s.id = ANY(${cityStoreIdNums}::int[])`
//       : Prisma.empty;

//     const tPricesQuery = markStart();
//     const expandedAllPrices = itemCodes.length > 0
//       ? await prisma.$queryRaw<PriceExpandedRow[]>(Prisma.sql`
//           SELECT
//             pr.id AS "priceId",
//             pr.chain_id AS "chainId",
//             pr.item_code AS "itemCode",
//             e.value::numeric AS "itemPrice",
//             pr.base_price AS "basePrice",
//             pr.price_update_date AS "priceUpdateDate",
//             pr.unit_of_measure AS "unitOfMeasure",
//             pr.unit_qty AS "unitQty",
//             pr.b_is_weighted AS "bIsWeighted",
//             s.id AS "storeDbId",
//             s.chain_id AS "storeChainId",
//             s.store_id AS "storeId",
//             s.chain_name AS "chainName",
//             s.store_name AS "storeName",
//             s.city AS "city"
//           FROM prices pr
//           CROSS JOIN LATERAL jsonb_each_text(pr.store_prices::jsonb) AS e(key, value)
//           JOIN stores s ON s.id = e.key::int
//           WHERE pr.item_code = ANY(${itemCodes})
//             AND e.key ~ '^[0-9]+$'
//             AND e.value ~ '^\s*[0-9]+(\.[0-9]+)?\s*$'
//             ${priceCityFilter}
//           ORDER BY pr.price_update_date DESC NULLS LAST
//         `)
//       : [];
//     markEnd('pricesQuery', tPricesQuery);

//     const chainIds = Array.from(new Set(expandedAllPrices.map(p => p.chainId).filter(Boolean)));

//     const tPriceExpand = markStart();
//     const pricesByItemCode = new Map<string, any[]>();
//     for (const pr of expandedAllPrices) {
//       const code = pr.itemCode;
//       if (!pricesByItemCode.has(code)) pricesByItemCode.set(code, []);
//       pricesByItemCode.get(code)!.push({
//         id: `${pr.priceId}-${pr.storeDbId}`,
//         priceRowId: pr.priceId,
//         chainId: pr.chainId,
//         itemCode: pr.itemCode,
//         itemPrice: pr.itemPrice.toString(),
//         basePrice: pr.basePrice,
//         priceUpdateDate: pr.priceUpdateDate,
//         unitOfMeasure: pr.unitOfMeasure,
//         unitQty: pr.unitQty,
//         bIsWeighted: pr.bIsWeighted,
//         store: {
//           id: pr.storeDbId,
//           chainId: pr.storeChainId,
//           storeId: pr.storeId,
//           chainName: pr.chainName,
//           storeName: pr.storeName,
//           city: pr.city,
//         },
//       });
//     }
//     markEnd('priceExpandAndMap', tPriceExpand);

//     type PromoRow = {
//       id: number;
//       promotion_id: string;
//       promotion_description: string | null;
//       promotion_start_date: Date;
//       promotion_end_date: Date;
//       chain_id: string;
//       available_in_store_ids: string[];
//       discounted_price: string | null;
//       matched_item_code: string;
//     };
//     const now = new Date();
//     const tPromotionsQuery = markStart();
//     const promoCityFilter = cityText
//       ? Prisma.sql`AND p.available_in_store_ids && ${cityStoreIdStrings}::text[]`
//       : Prisma.empty;
//     const promoChainFilter = chainIds.length > 0
//       ? Prisma.sql`AND p.chain_id = ANY(${chainIds}::text[])`
//       : Prisma.empty;

//     const promoRows: PromoRow[] = itemCodes.length > 0
//       ? await prisma.$queryRaw<PromoRow[]>(Prisma.sql`
//           SELECT DISTINCT ON (p.id, pi.item_code)
//                  p.id,
//                  p.promotion_id,
//                  p.promotion_description,
//                  p.promotion_start_date,
//                  p.promotion_end_date,
//                  p.chain_id,
//                  p.available_in_store_ids,
//                  COALESCE(p.discounted_price, pi.discounted_price::text) AS discounted_price,
//                  pi.item_code AS matched_item_code
//           FROM promotions p
//           JOIN promotion_items pi ON pi.promotion_db_id = p.id
//           WHERE pi.item_code = ANY(${itemCodes})
//             AND p.promotion_start_date <= ${now}
//             AND p.promotion_end_date >= ${now}
//             AND (p.club_id IS NULL OR p.club_id != '2')
//             ${promoCityFilter}
//             ${promoChainFilter}
//         `)
//       : [];
//     markEnd('promotionsQuery', tPromotionsQuery);

//     const tPromoExtract = markStart();
//     const promosByItemCode = new Map<string, PromoRow[]>();
//     for (const promo of promoRows) {
//       const code = promo.matched_item_code;
//       if (!promosByItemCode.has(code)) promosByItemCode.set(code, []);
//       promosByItemCode.get(code)!.push(promo);
//     }
//     markEnd('promotionsExtract', tPromoExtract);

//     const tMerge = markStart();
//     const products = await Promise.all(
//       rows.map(async row => {
//         const promotions = promosByItemCode.get(row.itemCode) ?? [];
//         const prices = pricesByItemCode.get(row.itemCode) ?? [];
//         let minDiscountedPrice: number | null = null;
//         for (const promo of promotions) {
//           const p = promo.discounted_price ? parseFloat(promo.discounted_price) : NaN;
//           if (!Number.isFinite(p)) continue;
//           if (minDiscountedPrice === null || p < minDiscountedPrice) minDiscountedPrice = p;
//         }
//         let minPrice: number | null = null;
//         for (const pr of prices) {
//           const p = pr.itemPrice ? parseFloat(pr.itemPrice) : NaN;
//           if (!Number.isFinite(p)) continue;
//           if (minPrice === null || p < minPrice) minPrice = p;
//         }
//         const effectivePrice = minDiscountedPrice ?? minPrice;

//         // Résolution de l'image en parallèle
//         let imageUrl: string | null = null;
//         try {
//           const imgRes = await resolveImage(row.itemCode);
//           imageUrl = imgRes?.imageUrl || null;
//         } catch (e) {
//           console.warn(`[SEARCH] Failed to resolve image for ${row.itemCode}:`, e);
//           imageUrl = null;
//         }

//         return {
//           itemCode: row.itemCode,
//           itemName: row.itemName,
//           manufacturerName: row.manufacturerName,
//           manufactureCountry: row.manufactureCountry,
//           rank: row.rank,
//           hasPromo: promotions.length > 0,
//           minPrice: minPrice !== null ? String(minPrice) : null,
//           minDiscountedPrice: minDiscountedPrice !== null ? String(minDiscountedPrice) : null,
//           effectivePrice: effectivePrice !== null ? String(effectivePrice) : null,
//           prices,
//           promotions,
//           imageUrl,
//         };
//       })
//     );

//     const strictCityProducts = cityText
//       ? products.filter(p => Array.isArray(p.prices) && p.prices.length > 0)
//       : products;

//     strictCityProducts.sort((a, b) => {
//       if (b.rank !== a.rank) return b.rank - a.rank;
//       if (a.hasPromo !== b.hasPromo) return a.hasPromo ? -1 : 1;
//       return (a.itemName || '').localeCompare(b.itemName || '');
//     });
//     markEnd('mergeAndSort', tMerge);

//     timingsMs.total = Number(process.hrtime.bigint() - tRouteStart) / 1_000_000;
//     res.setHeader(
//       'Server-Timing',
//       Object.entries(timingsMs)
//         .map(([k, v]) => `${k};dur=${v.toFixed(1)}`)
//         .join(', ')
//     );
//     console.info('products.search.timing', {
//       q: queryText,
//       city: cityText || null,
//       page: pageNum,
//       limit: limitNum,
//       resultCount: strictCityProducts.length,
//       timingsMs,
//     });

//     const payload = {
//       products: strictCityProducts,
//       pagination: {
//         page: pageNum,
//         limit: limitNum,
//         total: strictCityProducts.length,
//         totalPages: strictCityProducts.length === 0 ? 0 : 1,
//       },
//     };

//     searchResponseCache.set(searchCacheKey, {
//       expiresAt: Date.now() + SEARCH_CACHE_TTL_MS,
//       payload,
//     });

//     return res.json(payload);
//   } catch (error) {
//     console.error('Search error:', error);
//     return res.status(500).json({ error: 'Internal server error', detail: String(error) });
//   }
// });

// ─── GET /api/products/:barcode ───────────────────────────────────────────────
router.get('/:barcode', async (req, res) => {
  const tRouteStart = process.hrtime.bigint();
  const timingsMs: Record<string, number> = {};
  try {
    const { barcode } = req.params;
    // Validate barcode format (EAN-8 to EAN-14)
    if (!/^\d{8,14}$/.test(barcode)) {
      return res.status(400).json({ error: 'Invalid barcode format' });
    }
    const { city } = req.query;
    const cityText = typeof city === 'string' ? city.trim() : '';

    type ProductDetailRow = {
      id: number;
      item_code: string;
      item_name: string | null;
      manufacturer_name: string | null;
      manufacturer_item_description: string | null;
      manufacture_country: string | null;
    };

    const tProductSql = process.hrtime.bigint();
    const productRows = await prisma.$queryRaw<ProductDetailRow[]>(Prisma.sql`
      SELECT
        p.id,
        p.item_code,
        p.item_name,
        p.manufacturer_name,
        p.manufacturer_item_description,
        p.manufacture_country
      FROM products p
      WHERE p.item_code = ${barcode}::text
      LIMIT 1
    `);
    timingsMs.productSql = elapsedMs(tProductSql);

    if (productRows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const tOffersSql = process.hrtime.bigint();
    const offerRows = await prisma.$queryRaw<RawOfferRow[]>(Prisma.sql`
      SELECT
        o.item_code,
        o.item_name,
        o.manufacturer_name,
        o.chain_id,
        s_name.chain_name,
        o.store_id,
        o.store_name,
        o.city,
        o.price,
        o.promo_price,
        o.effective_price,
        o.unit_of_measure,
        o.unit_qty,
        o.b_is_weighted,
        o.updated_at
      FROM public.get_offers_for_item_code(
        ${barcode}::text,
        ${cityText || null}::text,
        NULL::text,
        300::integer,
        0::integer,
        NULL::text
      ) o
      LEFT JOIN LATERAL (
        SELECT chain_name FROM stores WHERE chain_id = o.chain_id AND store_id = o.store_id LIMIT 1
      ) s_name ON true
      ORDER BY o.effective_price ASC NULLS LAST, o.updated_at DESC NULLS LAST, o.store_id ASC
    `);
    timingsMs.offersSql = elapsedMs(tOffersSql);

    const tMap = process.hrtime.bigint();
    const mappedOffers = await enrichApiOffersWithPromoContext(
      prisma,
      offerRows.map(mapOfferRow),
    );
    const detail = mapOffersToLegacyDetails(mappedOffers);
    const productRow = productRows[0];
    timingsMs.mapping = elapsedMs(tMap);
    timingsMs.total = elapsedMs(tRouteStart);
    res.setHeader('Server-Timing', toServerTiming(timingsMs));
    console.info('perf.products.detail', {
      barcode,
      city: cityText || null,
      offerRows: offerRows.length,
      timingsMs,
    });

    return res.json({
      product: {
        id: productRow.id,
        itemCode: productRow.item_code,
        itemName: productRow.item_name,
        manufacturerName: productRow.manufacturer_name,
        manufacturerItemDescription: productRow.manufacturer_item_description,
        manufactureCountry: productRow.manufacture_country,
        imageUrl: getProductDeliveryUrl(productRow.item_code),
      },
      prices: detail.prices,
      promotions: detail.promotions,
    });
  } catch (error) {
    console.error('Product detail error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;

