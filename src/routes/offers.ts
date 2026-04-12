import { Router } from 'express';
import { Prisma, PrismaClient } from '@prisma/client';
import { buildOffsetPagination, mapOfferRow, RawOfferRow, toNullableNumber } from '../services/offerMapping';
import { buildPromoLookupKey, enrichApiOffersWithPromoContext, resolvePromoContexts } from '../services/promoContext';

const router = Router();
const prisma = new PrismaClient();

function elapsedMs(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1_000_000;
}

function toServerTiming(timingsMs: Record<string, number>): string {
  return Object.entries(timingsMs)
    .map(([k, v]) => `${k};dur=${v.toFixed(1)}`)
    .join(', ');
}

function parseOffset(raw: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(raw ?? ''), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseLimit(raw: unknown, fallback: number, max: number): number {
  const parsed = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function parseWindowHours(raw: unknown, fallback: number, max: number): number {
  const parsed = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed <= 0) return 0;
  return Math.min(parsed, max);
}

function parseBooleanQuery(raw: unknown, fallback: boolean): boolean {
  if (typeof raw !== 'string') return fallback;
  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseUnknownBoolean(raw: unknown, fallback = false): boolean {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw !== 0 : fallback;

  const normalized = String(raw ?? '').trim().toLowerCase();
  if (!normalized) return fallback;
  if (['1', 'true', 't', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'f', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

type RawTopPromotionRow = {
  item_code: string;
  item_name: string | null;
  manufacturer_name: string | null;
  chain_id: string;
  chain_name: string | null;
  store_id: string;
  store_name: string | null;
  city: string | null;
  unit_of_measure: string | null;
  unit_qty: string | null;
  b_is_weighted: unknown;
  price: unknown;
  promo_price: unknown;
  effective_price: unknown;
  discount_amount: unknown;
  discount_percent: unknown;
  smart_score: unknown;
  promotion_end_date: Date | string | null;
  updated_at: Date | string | null;
};

type ChainFilterRow = {
  chain_id: string;
  chain_name: string | null;
};

type StoreFilterRow = {
  chain_id: string;
  chain_name: string | null;
  store_id: string;
  store_name: string | null;
  city: string | null;
};

type TopPromotionDto = {
  itemCode: string;
  itemName: string | null;
  manufacturerName: string | null;
  chainId: string;
  chainName: string | null;
  storeId: string;
  storeName: string | null;
  city: string | null;
  unitOfMeasure: string | null;
  unitQty: string | null;
  bIsWeighted: boolean;
  price: number | null;
  promoPrice: number | null;
  effectivePrice: number | null;
  discountAmount: number | null;
  discountPercent: number | null;
  smartScore: number | null;
  promotionEndDate: string | null;
  promotionId: string | null;
  promotionDescription: string | null;
  promoKind: string | null;
  promoLabel: string | null;
  isConditionalPromo: boolean;
  updatedAt: string | null;
};

const DELIVERY_KEYWORD = 'משלוח';
const BARCODE_ITEM_CODE_REGEX = /^[0-9]{8,14}$/;
const PROMOTIONS_SCAN_BATCH_LIMIT = 100;
const PROMOTIONS_MAX_SCANNED_ROWS = 1000;
let topPromotionsPrewarmPromise: Promise<void> | null = null;

function ensureTopPromotionsCachePrewarm(windowHours = 24, topN = 200): Promise<void> {
  if (!topPromotionsPrewarmPromise) {
    topPromotionsPrewarmPromise = prisma
      .$queryRaw(Prisma.sql`
        SELECT refresh_top_promotions_cache(${windowHours}::integer, ${topN}::integer) AS affected
      `)
      .then(() => undefined)
      .catch((error) => {
        console.warn('offers.top-promotions prewarm failed:', error);
      });
  }

  return topPromotionsPrewarmPromise;
}

void ensureTopPromotionsCachePrewarm();

function mapTopPromotionRow(row: RawTopPromotionRow): TopPromotionDto {
  return {
    itemCode: row.item_code,
    itemName: row.item_name,
    manufacturerName: row.manufacturer_name,
    chainId: row.chain_id,
    chainName: row.chain_name,
    storeId: row.store_id,
    storeName: row.store_name,
    city: row.city,
    unitOfMeasure: row.unit_of_measure,
    unitQty: row.unit_qty,
    bIsWeighted: parseUnknownBoolean(row.b_is_weighted, false),
    price: toNullableNumber(row.price),
    promoPrice: toNullableNumber(row.promo_price),
    effectivePrice: toNullableNumber(row.effective_price),
    discountAmount: toNullableNumber(row.discount_amount),
    discountPercent: toNullableNumber(row.discount_percent),
    smartScore: toNullableNumber(row.smart_score),
    promotionEndDate: row.promotion_end_date
      ? new Date(row.promotion_end_date).toISOString().slice(0, 10)
      : null,
    promotionId: null,
    promotionDescription: null,
    promoKind: null,
    promoLabel: null,
    isConditionalPromo: false,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

function isValidTopPromotion(promo: TopPromotionDto): boolean {
  const itemCode = (promo.itemCode || '').trim();
  if (!BARCODE_ITEM_CODE_REGEX.test(itemCode)) return false;

  const itemName = (promo.itemName || '').trim();
  if (!itemName || itemName.includes(DELIVERY_KEYWORD)) return false;

  const basePrice = promo.price;
  const effectivePrice = promo.effectivePrice ?? promo.promoPrice;
  if (basePrice === null || effectivePrice === null) return false;
  if (!Number.isFinite(basePrice) || !Number.isFinite(effectivePrice)) return false;
  if (basePrice <= 0 || effectivePrice <= 0) return false;

  return effectivePrice < basePrice;
}

function normalizeProductName(value: string | null | undefined): string {
  return (value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function buildTopPromotionDedupeKey(promo: TopPromotionDto): string {
  const normalizedName = normalizeProductName(promo.itemName);
  const scopedSuffix = `${promo.chainId || ''}::${promo.storeId || ''}`;
  if (normalizedName) return `${normalizedName}::${scopedSuffix}`;
  return `${(promo.itemCode || '').trim()}::${scopedSuffix}`;
}

function parseItemCodes(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 100);
}

router.get('/by-item-code', async (req, res) => {
  const tRouteStart = process.hrtime.bigint();
  const timingsMs: Record<string, number> = {};
  try {
    const itemCode = typeof req.query.itemCode === 'string' ? req.query.itemCode.trim() : '';
    const city = typeof req.query.city === 'string' ? req.query.city.trim() : '';
    const chainId = typeof req.query.chainId === 'string' ? req.query.chainId.trim() : '';
    const limit = parseLimit(req.query.limit, 100, 300);
    const offset = parseOffset(req.query.offset, 0);

    if (!itemCode) {
      return res.status(400).json({ error: 'itemCode is required' });
    }

    const tSql = process.hrtime.bigint();
    const rows = await prisma.$queryRaw<RawOfferRow[]>(Prisma.sql`
      SELECT
        item_code,
        item_name,
        manufacturer_name,
        chain_id,
        store_id,
        store_name,
        city,
        price,
        promo_price,
        effective_price,
        unit_of_measure,
        unit_qty,
        b_is_weighted,
        updated_at
      FROM public.get_offers_for_item_code(
        ${itemCode}::text,
        ${city || null}::text,
        ${chainId || null}::text,
        ${limit}::integer,
        ${offset}::integer
      )
      ORDER BY effective_price ASC NULLS LAST, updated_at DESC NULLS LAST, store_id ASC
    `);
    timingsMs.sql = elapsedMs(tSql);

    const tMap = process.hrtime.bigint();
    const mappedOffers = rows.map(mapOfferRow);
    const offers = await enrichApiOffersWithPromoContext(prisma, mappedOffers);
    timingsMs.mapping = elapsedMs(tMap);
    timingsMs.total = elapsedMs(tRouteStart);
    res.setHeader('Server-Timing', toServerTiming(timingsMs));
    console.info('perf.offers.by-item-code', {
      itemCode,
      city: city || null,
      chainId: chainId || null,
      limit,
      offset,
      rowCount: rows.length,
      timingsMs,
    });

    return res.json({
      offers,
      pagination: buildOffsetPagination(limit, offset, rows.length),
    });
  } catch (error) {
    console.error('offers.by-item-code error:', error);
    return res.status(500).json({ error: 'Internal server error', detail: String(error) });
  }
});

router.get('/by-search', async (req, res) => {
  const tRouteStart = process.hrtime.bigint();
  const timingsMs: Record<string, number> = {};
  try {
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const city = typeof req.query.city === 'string' ? req.query.city.trim() : '';
    const chainId = typeof req.query.chainId === 'string' ? req.query.chainId.trim() : '';
    const limitProducts = parseLimit(req.query.limitProducts, 10, 100);
    const offsetProducts = parseOffset(req.query.offsetProducts, 0);

    if (!query) {
      return res.status(400).json({ error: 'q is required' });
    }

    type SearchOfferRow = RawOfferRow & { product_rank: number | null };

    const tSql = process.hrtime.bigint();
    const rows = await prisma.$queryRaw<SearchOfferRow[]>(Prisma.sql`
      SELECT
        product_rank,
        item_code,
        item_name,
        manufacturer_name,
        chain_id,
        store_id,
        store_name,
        city,
        price,
        promo_price,
        effective_price,
        unit_of_measure,
        unit_qty,
        b_is_weighted,
        updated_at
      FROM public.get_city_offers_for_search(
        ${query}::text,
        ${city || null}::text,
        ${chainId || null}::text,
        ${limitProducts}::integer,
        ${offsetProducts}::integer
      )
      ORDER BY product_rank DESC NULLS LAST, effective_price ASC NULLS LAST, updated_at DESC NULLS LAST, item_code ASC, store_id ASC
    `);
    timingsMs.sql = elapsedMs(tSql);

    const tMap = process.hrtime.bigint();
    const mappedOffers = rows.map((row) => ({
      productRank: toNullableNumber(row.product_rank),
      ...mapOfferRow(row),
    }));

    const offersWithContext = await enrichApiOffersWithPromoContext(prisma, mappedOffers.map((offer) => ({
      itemCode: offer.itemCode,
      itemName: offer.itemName,
      manufacturerName: offer.manufacturerName,
      chainId: offer.chainId,
      storeId: offer.storeId,
      storeName: offer.storeName,
      city: offer.city,
      price: offer.price,
      promoPrice: offer.promoPrice,
      effectivePrice: offer.effectivePrice,
      unitOfMeasure: offer.unitOfMeasure,
      unitQty: offer.unitQty,
      bIsWeighted: offer.bIsWeighted,
      promotionId: offer.promotionId,
      promotionDescription: offer.promotionDescription,
      promoKind: offer.promoKind,
      promoLabel: offer.promoLabel,
      isConditionalPromo: offer.isConditionalPromo,
      updatedAt: offer.updatedAt,
    })));

    const offers = mappedOffers.map((offer, index) => ({
      productRank: offer.productRank,
      ...offersWithContext[index],
    }));
    timingsMs.mapping = elapsedMs(tMap);
    timingsMs.total = elapsedMs(tRouteStart);
    res.setHeader('Server-Timing', toServerTiming(timingsMs));
    console.info('perf.offers.by-search', {
      query,
      city: city || null,
      chainId: chainId || null,
      limitProducts,
      offsetProducts,
      rowCount: rows.length,
      timingsMs,
    });

    return res.json({
      offers,
      pagination: buildOffsetPagination(limitProducts, offsetProducts, rows.length),
    });
  } catch (error) {
    console.error('offers.by-search error:', error);
    return res.status(500).json({ error: 'Internal server error', detail: String(error) });
  }
});

router.get('/by-item-codes', async (req, res) => {
  const tRouteStart = process.hrtime.bigint();
  const timingsMs: Record<string, number> = {};
  try {
    const itemCodes = parseItemCodes(req.query.itemCodes);
    const city = typeof req.query.city === 'string' ? req.query.city.trim() : '';
    const chainId = typeof req.query.chainId === 'string' ? req.query.chainId.trim() : '';
    const limitPerItem = parseLimit(req.query.limitPerItem, 200, 500);

    if (itemCodes.length === 0) {
      return res.status(400).json({ error: 'itemCodes is required (comma separated)' });
    }

    const tSql = process.hrtime.bigint();
    const rows = await prisma.$queryRaw<RawOfferRow[]>(Prisma.sql`
      WITH input_codes AS (
        SELECT unnest(${itemCodes}::text[]) AS item_code
      )
      SELECT
        o.item_code,
        o.item_name,
        o.manufacturer_name,
        o.chain_id,
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
        ${limitPerItem}::integer,
        0::integer
      ) o
      ORDER BY o.item_code ASC, o.effective_price ASC NULLS LAST, o.updated_at DESC NULLS LAST, o.store_id ASC
    `);
    timingsMs.sql = elapsedMs(tSql);

    const tMap = process.hrtime.bigint();
    const mappedOffers = rows.map(mapOfferRow);
    const offers = await enrichApiOffersWithPromoContext(prisma, mappedOffers);
    timingsMs.mapping = elapsedMs(tMap);
    timingsMs.total = elapsedMs(tRouteStart);
    res.setHeader('Server-Timing', toServerTiming(timingsMs));
    console.info('perf.offers.by-item-codes', {
      requestedItemCodes: itemCodes.length,
      city: city || null,
      chainId: chainId || null,
      limitPerItem,
      rowCount: rows.length,
      timingsMs,
    });

    return res.json({
      offers,
      meta: {
        requestedItemCodes: itemCodes.length,
        limitPerItem,
      },
    });
  } catch (error) {
    console.error('offers.by-item-codes error:', error);
    return res.status(500).json({ error: 'Internal server error', detail: String(error) });
  }
});

router.get('/top-promotions', async (req, res) => {
  const tRouteStart = process.hrtime.bigint();
  const timingsMs: Record<string, number> = {};

  try {
    const city = typeof req.query.city === 'string' ? req.query.city.trim() : '';
    const chainId = typeof req.query.chainId === 'string' ? req.query.chainId.trim() : '';
    const storeId = typeof req.query.storeId === 'string' ? req.query.storeId.trim() : '';
    const includeConditionalPromos = parseBooleanQuery(req.query.includeConditional, false);
    const windowHours = parseWindowHours(req.query.windowHours, 24, 168);
    const limit = parseLimit(req.query.limit, 50, 50);
    const offset = parseOffset(req.query.offset, 0);
    const sortBy = typeof req.query.sortBy === 'string' && ['percent', 'savings'].includes(req.query.sortBy) ? req.query.sortBy : 'score';

    if (!city) {
      return res.status(400).json({ error: 'city is required' });
    }

    const fetchTopPromotionsRows = (batchLimit: number, batchOffset: number) => prisma.$queryRaw<RawTopPromotionRow[]>(Prisma.sql`
      SELECT
        item_code,
        item_name,
        manufacturer_name,
        chain_id,
        chain_name,
        store_id,
        store_name,
        city,
        unit_of_measure,
        unit_qty,
        b_is_weighted,
        price,
        promo_price,
        effective_price,
        discount_amount,
        discount_percent,
        smart_score,
        promotion_end_date,
        updated_at
      FROM public.get_top_city_promotions(
        ${city}::text,
        ${chainId || null}::text,
        ${storeId || null}::text,
        ${windowHours}::integer,
        ${batchLimit}::integer,
        ${batchOffset}::integer,
        ${sortBy}::text
      )
    `);

    const tPromotionsSql = process.hrtime.bigint();
    const targetCount = offset + limit + 1;
    const collected: TopPromotionDto[] = [];
    const seenPromotionKeys = new Set<string>();
    let scanOffset = 0;
    let scannedRows = 0;
    let sourceExhausted = false;
    let cacheWarmupDone = false;

    while (collected.length < targetCount && scannedRows < PROMOTIONS_MAX_SCANNED_ROWS) {
      let rows = await fetchTopPromotionsRows(PROMOTIONS_SCAN_BATCH_LIMIT, scanOffset);

      // Cold-start safeguard: warm the SQL cache once and retry from the first page.
      if (rows.length === 0 && !cacheWarmupDone && scanOffset === 0) {
        const tWarmup = process.hrtime.bigint();
        await ensureTopPromotionsCachePrewarm(windowHours, 200);
        timingsMs.cacheWarmupSql = elapsedMs(tWarmup);
        cacheWarmupDone = true;
        rows = await fetchTopPromotionsRows(PROMOTIONS_SCAN_BATCH_LIMIT, scanOffset);
      }

      if (rows.length === 0) {
        sourceExhausted = true;
        break;
      }

      scanOffset += rows.length;
      scannedRows += rows.length;

      const mappedRows = rows.map(mapTopPromotionRow);
      const contextMap = await resolvePromoContexts(
        prisma,
        mappedRows.map((promo) => ({
          itemCode: promo.itemCode,
          chainId: promo.chainId,
          storeId: promo.storeId,
          promoPrice: promo.promoPrice,
        })),
      );

      const enrichedRows = mappedRows.map((promo) => {
        const key = buildPromoLookupKey(promo.itemCode, promo.chainId, promo.storeId);
        const context = contextMap.get(key);
        return {
          ...promo,
          promotionId: context?.promotionId ?? null,
          promotionDescription: context?.promotionDescription ?? null,
          promoKind: context?.promoKind ?? (promo.promoPrice !== null ? 'regular' : null),
          promoLabel: context?.promoLabel ?? (promo.promoPrice !== null ? 'מבצע' : null),
          isConditionalPromo: context?.isConditionalPromo ?? false,
        };
      });

      for (const promo of enrichedRows) {
        if (!isValidTopPromotion(promo)) continue;
        if (!includeConditionalPromos && promo.isConditionalPromo) continue;

        // Keep a single card per product name across city results.
        const dedupeKey = buildTopPromotionDedupeKey(promo);
        if (seenPromotionKeys.has(dedupeKey)) continue;

        seenPromotionKeys.add(dedupeKey);
        collected.push(promo);

        if (collected.length >= targetCount) break;
      }

      // Do not infer exhaustion from a short page; SQL function can enforce its own max page size.
    }

    timingsMs.promotionsSql = elapsedMs(tPromotionsSql);

    const tMap = process.hrtime.bigint();
    const promotions = collected.slice(offset, offset + limit);
    const hasMorePromotions =
      collected.length > (offset + limit)
      || (!sourceExhausted && scannedRows >= PROMOTIONS_MAX_SCANNED_ROWS);
    timingsMs.mapping = elapsedMs(tMap);

    const tFiltersSql = process.hrtime.bigint();
    const [chainRows, storeRows] = await Promise.all([
      prisma.$queryRaw<ChainFilterRow[]>(Prisma.sql`
        SELECT DISTINCT
          s.chain_id,
          COALESCE(NULLIF(s.chain_name, ''), s.chain_id)::text AS chain_name
        FROM stores s
        WHERE s.city ILIKE ${city}::text || '%'
        ORDER BY chain_name ASC
        LIMIT 100
      `),
      prisma.$queryRaw<StoreFilterRow[]>(Prisma.sql`
        SELECT
          s.chain_id,
          COALESCE(NULLIF(s.chain_name, ''), s.chain_id)::text AS chain_name,
          s.store_id,
          COALESCE(NULLIF(s.store_name, ''), s.store_id)::text AS store_name,
          s.city::text AS city
        FROM stores s
        WHERE s.city ILIKE ${city}::text || '%'
          AND (${chainId || null}::text IS NULL OR s.chain_id = ${chainId || null}::text)
        ORDER BY chain_name ASC, store_name ASC
        LIMIT 500
      `),
    ]);
    const filtersElapsed = elapsedMs(tFiltersSql);
    timingsMs.chainsSql = filtersElapsed;
    timingsMs.storesSql = filtersElapsed;

    const tMeta = process.hrtime.bigint();
    let lastDataUpdateAt: string | null = null;
    for (const promo of promotions) {
      if (!promo.updatedAt) continue;
      if (!lastDataUpdateAt || promo.updatedAt > lastDataUpdateAt) {
        lastDataUpdateAt = promo.updatedAt;
      }
    }

    const chainPromoCounts = new Map<string, number>();
    const storePromoCounts = new Map<string, number>();
    for (const promo of promotions) {
      chainPromoCounts.set(promo.chainId, (chainPromoCounts.get(promo.chainId) ?? 0) + 1);
      const storeKey = `${promo.chainId}::${promo.storeId}`;
      storePromoCounts.set(storeKey, (storePromoCounts.get(storeKey) ?? 0) + 1);
    }
    timingsMs.meta = elapsedMs(tMeta);

    const chainFilters = chainRows
      .map((row) => ({
        chainId: row.chain_id,
        chainName: row.chain_name,
        promoCount: chainPromoCounts.get(row.chain_id) ?? 0,
      }));

    const storeFilters = storeRows
      .map((row) => ({
        chainId: row.chain_id,
        chainName: row.chain_name,
        storeId: row.store_id,
        storeName: row.store_name,
        city: row.city,
        promoCount: storePromoCounts.get(`${row.chain_id}::${row.store_id}`) ?? 0,
      }))
      .filter((row) => {
        if (row.promoCount > 0) return true;
        if (chainId && row.chainId === chainId) {
          return !storeId || row.storeId === storeId;
        }
        return false;
      });

    timingsMs.total = elapsedMs(tRouteStart);
    res.setHeader('Server-Timing', toServerTiming(timingsMs));

    console.info('perf.offers.top-promotions', {
      city,
      chainId: chainId || null,
      storeId: storeId || null,
      includeConditionalPromos,
      windowHours,
      limit,
      offset,
      rowCount: promotions.length,
      scannedRows,
      sourceExhausted,
      timingsMs,
    });

    const basePagination = buildOffsetPagination(limit, offset, promotions.length);

    return res.json({
      promotions,
      filters: {
        chains: chainFilters,
        stores: storeFilters,
      },
      meta: {
        city,
        chainId: chainId || null,
        storeId: storeId || null,
        windowHours,
        lastDataUpdateAt,
      },
      pagination: {
        ...basePagination,
        hasMore: hasMorePromotions,
        totalPages: hasMorePromotions ? basePagination.page + 1 : basePagination.page,
      },
    });
  } catch (error) {
    console.error('offers.top-promotions error:', error);
    return res.status(500).json({ error: 'Internal server error', detail: String(error) });
  }
});

// ─── Types pour store_promotions_cache ────────────────────────────────────────

type RawStorePromoRow = {
  store_db_id: number | bigint;
  chain_id: string;
  chain_name: string | null;
  store_id: string;
  store_name: string | null;
  city: string | null;
  time_window: string;
  promo_type: string;
  sort_metric: string;
  rank_position: number;
  item_code: string;
  item_name: string | null;
  manufacturer_name: string | null;
  unit_of_measure: string | null;
  unit_qty: string | null;
  b_is_weighted: unknown;
  price: unknown;
  promo_price: unknown;
  effective_price: unknown;
  discount_amount: unknown;
  discount_percent: unknown;
  smart_score: unknown;
  promo_kind: string | null;
  promo_label: string | null;
  promotion_id: string | null;
  promotion_description: string | null;
  promotion_end_date: Date | string | null;
  updated_at: Date | string | null;
};

type StorePromoDto = {
  storeDbId: number;
  chainId: string;
  chainName: string | null;
  storeId: string;
  storeName: string | null;
  city: string | null;
  timeWindow: string;
  promoType: string;
  sortMetric: string;
  rankPosition: number;
  itemCode: string;
  itemName: string | null;
  manufacturerName: string | null;
  unitOfMeasure: string | null;
  unitQty: string | null;
  bIsWeighted: boolean;
  price: number | null;
  promoPrice: number | null;
  effectivePrice: number | null;
  discountAmount: number | null;
  discountPercent: number | null;
  smartScore: number | null;
  promoKind: string | null;
  promoLabel: string | null;
  promotionId: string | null;
  promotionDescription: string | null;
  promotionEndDate: string | null;
  updatedAt: string | null;
};

function mapStorePromoRow(row: RawStorePromoRow): StorePromoDto {
  return {
    storeDbId: Number(row.store_db_id),
    chainId: row.chain_id,
    chainName: row.chain_name,
    storeId: row.store_id,
    storeName: row.store_name,
    city: row.city,
    timeWindow: row.time_window,
    promoType: row.promo_type,
    sortMetric: row.sort_metric,
    rankPosition: Number(row.rank_position),
    itemCode: row.item_code,
    itemName: row.item_name,
    manufacturerName: row.manufacturer_name,
    unitOfMeasure: row.unit_of_measure,
    unitQty: row.unit_qty,
    bIsWeighted: parseUnknownBoolean(row.b_is_weighted, false),
    price: toNullableNumber(row.price),
    promoPrice: toNullableNumber(row.promo_price),
    effectivePrice: toNullableNumber(row.effective_price),
    discountAmount: toNullableNumber(row.discount_amount),
    discountPercent: toNullableNumber(row.discount_percent),
    smartScore: toNullableNumber(row.smart_score),
    promoKind: row.promo_kind,
    promoLabel: row.promo_label,
    promotionId: row.promotion_id,
    promotionDescription: row.promotion_description,
    promotionEndDate: row.promotion_end_date
      ? new Date(row.promotion_end_date).toISOString().slice(0, 10)
      : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

type ValidTimeWindow = '24h' | '7days' | '30days';
type ValidPromoType  = 'regular' | 'conditional';
type ValidSortMetric = 'percent' | 'savings';

function parseTimeWindow(raw: unknown, fallback: ValidTimeWindow): ValidTimeWindow {
  const valid: ValidTimeWindow[] = ['24h', '7days', '30days'];
  const s = String(raw ?? '').trim().toLowerCase();
  return valid.includes(s as ValidTimeWindow) ? (s as ValidTimeWindow) : fallback;
}

function parsePromoType(raw: unknown, fallback: ValidPromoType): ValidPromoType {
  const s = String(raw ?? '').trim().toLowerCase();
  return s === 'conditional' ? 'conditional' : fallback;
}

function parseSortMetric(raw: unknown, fallback: ValidSortMetric): ValidSortMetric {
  const s = String(raw ?? '').trim().toLowerCase();
  return s === 'savings' ? 'savings' : fallback;
}

// ─── GET /store-promos ──────────────────────────────────────────────────────
// 1 fetch = 1 carrousel. Lecture directe dans store_promotions_cache.
// Paramètres :
//   city*        : ville (obligatoire)
//   chainId      : filtre chaîne
//   storeId      : filtre magasin
//   timeWindow   : '24h' | '7days' | '30days'  (défaut: '24h')
//   promoType    : 'regular' | 'conditional'   (défaut: 'regular')
//   sortBy       : 'percent' | 'savings'       (défaut: 'percent')
// ───────────────────────────────────────────────────────────────────────────
router.get('/store-promos', async (req, res) => {
  const tStart = process.hrtime.bigint();
  const timingsMs: Record<string, number> = {};

  try {
    const city       = typeof req.query.city    === 'string' ? req.query.city.trim()    : '';
    const chainId    = typeof req.query.chainId === 'string' ? req.query.chainId.trim() : '';
    const storeId    = typeof req.query.storeId === 'string' ? req.query.storeId.trim() : '';
    const timeWindow = parseTimeWindow(req.query.timeWindow, '24h');
    const promoType  = parsePromoType(req.query.promoType,   'regular');
    const sortBy     = parseSortMetric(req.query.sortBy,     'percent');

    if (!city) {
      return res.status(400).json({ error: 'city is required' });
    }

    const limit = Number(req.query.limit) || 80;
    const offset = Number(req.query.offset) || 0;

    const tSql = process.hrtime.bigint();
    const rows = await prisma.$queryRaw<RawStorePromoRow[]>(
      sortBy === 'percent'
        ? Prisma.sql`
            SELECT * FROM public.store_promotions_cache
            WHERE city = ${city}
              AND time_window = ${timeWindow}
              AND promo_type = ${promoType}
              AND sort_metric = 'percent'
              ${chainId ? Prisma.sql`AND chain_id = ${chainId}` : Prisma.empty}
              ${storeId ? Prisma.sql`AND store_id = ${storeId}` : Prisma.empty}
            ORDER BY discount_percent DESC NULLS LAST, store_db_id ASC, rank_position ASC
            LIMIT ${limit} OFFSET ${offset}
          `
        : Prisma.sql`
            SELECT * FROM public.store_promotions_cache
            WHERE city = ${city}
              AND time_window = ${timeWindow}
              AND promo_type = ${promoType}
              AND sort_metric = 'savings'
              ${chainId ? Prisma.sql`AND chain_id = ${chainId}` : Prisma.empty}
              ${storeId ? Prisma.sql`AND store_id = ${storeId}` : Prisma.empty}
            ORDER BY discount_amount DESC NULLS LAST, store_db_id ASC, rank_position ASC
            LIMIT ${limit} OFFSET ${offset}
          `
    );
    timingsMs.sql = elapsedMs(tSql);

    const tMap = process.hrtime.bigint();
    const promotions = rows.map(mapStorePromoRow);
    timingsMs.mapping = elapsedMs(tMap);
    timingsMs.total   = elapsedMs(tStart);

    res.setHeader('Server-Timing', toServerTiming(timingsMs));
    console.info(`[offers.store-promos] DONE in ${timingsMs.total.toFixed(2)}ms`, {
      city, timeWindow, promoType, sortBy, rowCount: promotions.length, 
      sqlTime: `${timingsMs.sql.toFixed(2)}ms`, mapTime: `${timingsMs.mapping.toFixed(2)}ms`
    });

    return res.json({
      promotions,
      meta: {
        city,
        chainId: chainId || null,
        storeId: storeId || null,
        timeWindow,
        promoType,
        sortBy,
        count: promotions.length,
      },
    });
  } catch (error) {
    const tFail = elapsedMs(tStart);
    console.error(`[offers.store-promos] ERROR after ${tFail}ms:`, error);
    return res.status(500).json({ error: 'Internal server error', detail: String(error) });
  }
});

// ─── DELETE /store-promos/item/:itemCode ──────────────────────────────────
// Supprime définitivement une promotion du cache si on a détecté
// qu'elle n'avait aucune image valide (ni Cloudinary, ni Pricez, ni OpenFood).
// ───────────────────────────────────────────────────────────────────────────
router.delete('/store-promos/item/:itemCode', async (req, res) => {
  const tStart = process.hrtime.bigint();
  try {
    const itemCode = req.params.itemCode;
    if (!itemCode) return res.status(400).json({ error: 'itemCode required' });
    
    // On efface l'item de la table de cache de promotions
    const deleteRes = await prisma.$executeRaw(Prisma.sql`
      DELETE FROM public.store_promotions_cache
      WHERE item_code = ${itemCode}::varchar
    `);
    
    console.info(`[DELETE store-promos/item] Removed ${deleteRes} rows for ${itemCode} in ${elapsedMs(tStart)}ms`);
    return res.json({ success: true, removedRows: deleteRes });
  } catch (error) {
    console.error('[DELETE store-promos/item] Error:', error);
    return res.status(500).json({ error: 'Failed to delete item from promos cache' });
  }
});

// ─── GET /store-promos-meta ─────────────────────────────────────────────────
// Retourne la liste des chaînes et magasins ayant des données en cache
// pour une ville + fenêtre temporelle donnée. Alimente les filtres UI.
// Paramètres :
//   city*        : ville (obligatoire)
//   timeWindow   : '24h' | '7days' | '30days'  (défaut: '24h')
//   chainId      : filtre chaîne optionnel (pour les stores)
// ───────────────────────────────────────────────────────────────────────────
router.get('/store-promos-meta', async (req, res) => {
  const tStart = process.hrtime.bigint();
  const timingsMs: Record<string, number> = {};

  try {
    const city       = typeof req.query.city    === 'string' ? req.query.city.trim()    : '';
    const chainId    = typeof req.query.chainId === 'string' ? req.query.chainId.trim() : '';
    const timeWindow = parseTimeWindow(req.query.timeWindow, '24h');

    if (!city) {
      return res.status(400).json({ error: 'city is required' });
    }

    type ChainMetaRow = { chain_id: string; chain_name: string | null; store_count: number; promo_count: number };
    type StoreMetaRow = {
      store_db_id: number;
      chain_id: string;
      chain_name: string | null;
      store_id: string;
      store_name: string | null;
      city: string | null;
      promo_count: number;
    };
    type RefreshedAtRow = { refreshed_at: Date | null };

    const tSql = process.hrtime.bigint();
    const [chainRows, storeRows, refreshedRows] = await Promise.all([

      // Chaînes distinctes avec compteurs
      prisma.$queryRaw<ChainMetaRow[]>(Prisma.sql`
        SELECT
          chain_id,
          chain_name,
          COUNT(DISTINCT store_db_id)::int  AS store_count,
          COUNT(*)::int                      AS promo_count
        FROM public.store_promotions_cache
        WHERE city = ${city}
          AND time_window = ${timeWindow}::varchar
          AND sort_metric = 'percent'
          AND promo_type  = 'regular'
        GROUP BY chain_id, chain_name
        ORDER BY chain_name ASC
      `),

      // Magasins avec compteurs
      prisma.$queryRaw<StoreMetaRow[]>(Prisma.sql`
        SELECT
          store_db_id,
          chain_id,
          chain_name,
          store_id,
          store_name,
          city,
          COUNT(*)::int AS promo_count
        FROM public.store_promotions_cache
        WHERE city = ${city}
          AND time_window = ${timeWindow}::varchar
          AND sort_metric = 'percent'
          AND promo_type  = 'regular'
          AND (${chainId || null}::varchar IS NULL OR chain_id = ${chainId || null}::varchar)
        GROUP BY store_db_id, chain_id, chain_name, store_id, store_name, city
        ORDER BY chain_name ASC, store_name ASC
      `),

      // Date du dernier refresh
      prisma.$queryRaw<RefreshedAtRow[]>(Prisma.sql`
        SELECT MAX(refreshed_at) AS refreshed_at
        FROM public.store_promotions_cache
        WHERE city = ${city}
          AND time_window = ${timeWindow}::varchar
      `),
    ]);

    timingsMs.sql   = elapsedMs(tSql);
    timingsMs.total = elapsedMs(tStart);
    res.setHeader('Server-Timing', toServerTiming(timingsMs));

    const lastRefreshedAt = refreshedRows[0]?.refreshed_at
      ? new Date(refreshedRows[0].refreshed_at).toISOString()
      : null;

    console.info('perf.offers.store-promos-meta', {
      city,
      timeWindow,
      chainCount: chainRows.length,
      storeCount: storeRows.length,
      timingsMs,
    });

    return res.json({
      chains: chainRows.map((r) => ({
        chainId:    r.chain_id,
        chainName:  r.chain_name ?? r.chain_id,
        storeCount: Number(r.store_count),
        promoCount: Number(r.promo_count),
      })),
      stores: storeRows.map((r) => ({
        storeDbId:  Number(r.store_db_id),
        chainId:    r.chain_id,
        chainName:  r.chain_name,
        storeId:    r.store_id,
        storeName:  r.store_name,
        city:       r.city,
        promoCount: Number(r.promo_count),
      })),
      meta: {
        city,
        timeWindow,
        lastRefreshedAt,
      },
    });
  } catch (error) {
    console.error('offers.store-promos-meta error:', error);
    return res.status(500).json({ error: 'Internal server error', detail: String(error) });
  }
});

export default router;