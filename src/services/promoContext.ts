import { Prisma, PrismaClient } from '@prisma/client';
import { ApiOffer } from './offerMapping';

export type PromoKind = 'regular' | 'coupon' | 'card' | 'club' | 'insurance' | 'conditional';

export type PromoLookupInput = {
  itemCode: string;
  chainId: string;
  storeId: string;
  promoPrice: number | null;
};

export type PromoContext = {
  promotionId: string | null;
  promotionDescription: string | null;
  promoKind: PromoKind;
  promoLabel: string;
  isConditionalPromo: boolean;
};

type RawPromoContextRow = {
  item_code: string;
  chain_id: string;
  store_id: string;
  promotion_id: string | null;
  promotion_description: string | null;
  additional_is_coupon: string | null;
  additional_restrictions: string | null;
  club_id: string | null;
};

const HEBREW_LABELS: Record<PromoKind, string> = {
  regular: 'מבצע',
  coupon: 'קופון',
  card: 'הטבת אשראי',
  club: 'הטבת מועדון',
  insurance: 'הטבת ביטוח',
  conditional: 'הטבה מותנית',
};

function normalizeText(value: string | null | undefined): string {
  return (value || '').trim().toLowerCase();
}

function parseMaybeNumber(value: string | null | undefined): number | null {
  const normalized = normalizeText(value).replace(',', '.');
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function looksTruthy(value: string | null | undefined): boolean {
  const normalized = normalizeText(value);
  if (['1', 'true', 't', 'yes', 'y', 'on'].includes(normalized)) return true;

  const numeric = parseMaybeNumber(value);
  return numeric !== null && numeric > 0;
}

function hasAny(text: string, needles: string[]): boolean {
  return needles.some((needle) => text.includes(needle));
}

function hasEnglishWord(text: string, word: string): boolean {
  return new RegExp(`(^|[^a-z])${word}([^a-z]|$)`, 'i').test(text);
}

function hasClubId(clubIdRaw: string | null | undefined): boolean {
  const normalized = normalizeText(clubIdRaw);
  if (!normalized) return false;
  if (['0', '0.0', '0.00', '0.000', 'no_body', 'none', 'null', 'nan'].includes(normalized)) {
    return false;
  }

  const numeric = parseMaybeNumber(clubIdRaw);
  if (numeric !== null) return numeric > 0;

  return true;
}

function isCouponFlagged(additionalIsCoupon: string | null, additionalRestrictions: string | null): boolean {
  const couponNumeric = parseMaybeNumber(additionalIsCoupon);
  if (couponNumeric !== null) return couponNumeric > 0;
  if (looksTruthy(additionalIsCoupon)) return true;

  const restrictions = normalizeText(additionalRestrictions);
  if (!restrictions) return false;

  return (
    /additionaliscoupon[^a-z0-9]*['"]?1(?:\.0+)?\b/.test(restrictions)
    || /additional[_\s-]*is[_\s-]*coupon[^a-z0-9]*['"]?1(?:\.0+)?\b/.test(restrictions)
  );
}

function classifyPromotionKind(row: Pick<RawPromoContextRow, 'promotion_description' | 'additional_is_coupon' | 'additional_restrictions' | 'club_id'>): PromoContext {
  const description = normalizeText(row.promotion_description);
  const restrictions = normalizeText(row.additional_restrictions);
  const combined = `${description} ${restrictions}`.trim();

  const isInsurance = hasAny(combined, ['ביטוח']) || hasEnglishWord(combined, 'insurance');
  const isCard = hasAny(combined, ['אשראי', 'כרטיס', 'ויזה', 'מאסטר', 'אמקס'])
    || hasEnglishWord(combined, 'visa')
    || hasEnglishWord(combined, 'mastercard')
    || hasEnglishWord(combined, 'card');
  const isCoupon = isCouponFlagged(row.additional_is_coupon, row.additional_restrictions)
    || hasAny(combined, ['קופון'])
    || hasEnglishWord(combined, 'coupon');
  const isClub = hasClubId(row.club_id)
    || hasAny(combined, ['מועדון', 'חברי מועדון', 'לקוחות מועדון'])
    || hasEnglishWord(combined, 'club');

  let promoKind: PromoKind = 'regular';
  if (isInsurance) promoKind = 'insurance';
  else if (isCard) promoKind = 'card';
  else if (isCoupon) promoKind = 'coupon';
  else if (isClub) promoKind = 'club';

  return {
    promotionId: null,
    promotionDescription: row.promotion_description,
    promoKind,
    promoLabel: HEBREW_LABELS[promoKind],
    isConditionalPromo: promoKind !== 'regular',
  };
}

export function buildPromoLookupKey(itemCode: string, chainId: string, storeId: string): string {
  return `${itemCode}::${chainId}::${storeId}`;
}

export function fallbackPromoContext(): PromoContext {
  return {
    promotionId: null,
    promotionDescription: null,
    promoKind: 'regular',
    promoLabel: HEBREW_LABELS.regular,
    isConditionalPromo: false,
  };
}

export async function resolvePromoContexts(
  prisma: PrismaClient,
  inputs: PromoLookupInput[],
): Promise<Map<string, PromoContext>> {
  const uniqueByKey = new Map<string, PromoLookupInput>();
  for (const input of inputs) {
    const itemCode = (input.itemCode || '').trim();
    const chainId = (input.chainId || '').trim();
    const storeId = (input.storeId || '').trim();
    if (!itemCode || !chainId) continue;

    const key = buildPromoLookupKey(itemCode, chainId, storeId);
    if (!uniqueByKey.has(key)) {
      uniqueByKey.set(key, {
        itemCode,
        chainId,
        storeId,
        promoPrice: input.promoPrice,
      });
    }
  }

  if (uniqueByKey.size === 0) {
    return new Map();
  }

  const payload = Array.from(uniqueByKey.values());

  const rows = await prisma.$queryRaw<RawPromoContextRow[]>(Prisma.sql`
    WITH input_rows AS (
      SELECT
        COALESCE(x->>'itemCode', '')::text AS item_code,
        COALESCE(x->>'chainId', '')::text AS chain_id,
        COALESCE(x->>'storeId', '')::text AS store_id,
        CASE
          WHEN COALESCE(x->>'promoPrice', '') ~ '^\s*[-]?[0-9]+(\.[0-9]+)?\s*$'
          THEN (x->>'promoPrice')::numeric
          ELSE NULL
        END AS promo_price
      FROM jsonb_array_elements(${JSON.stringify(payload)}::jsonb) AS x
    )
    SELECT
      ir.item_code,
      ir.chain_id,
      ir.store_id,
      cand.promotion_id,
      cand.promotion_description,
      cand.additional_is_coupon,
      cand.additional_restrictions,
      cand.club_id
    FROM input_rows ir
    LEFT JOIN products pr ON pr.item_code = ir.item_code
    LEFT JOIN stores s ON s.chain_id = ir.chain_id AND s.store_id = ir.store_id
    LEFT JOIN LATERAL (
      SELECT
        psi.promotion_id,
        p.promotion_description,
        p.additional_is_coupon,
        p.additional_restrictions,
        p.club_id,
        psi.promo_price,
        psi.updated_at
      FROM promotion_store_items psi
      LEFT JOIN promotions p
        ON p.chain_id = psi.chain_id
       AND p.promotion_id = psi.promotion_id
      WHERE pr.id IS NOT NULL
        AND psi.product_id = pr.id
        AND psi.chain_id = ir.chain_id
        AND (
          (ir.store_id <> '' AND s.id IS NOT NULL AND psi.store_id = s.id)
          OR (ir.store_id = '')
        )
        AND psi.promo_price IS NOT NULL
        AND (psi.promotion_end_date IS NULL OR psi.promotion_end_date >= CURRENT_DATE)
      ORDER BY
        CASE
          WHEN ir.promo_price IS NOT NULL THEN ABS(psi.promo_price - ir.promo_price)
          ELSE 0::numeric
        END ASC,
        psi.promo_price ASC NULLS LAST,
        psi.updated_at DESC NULLS LAST,
        psi.promotion_id ASC
      LIMIT 1
    ) cand ON TRUE
  `);

  const result = new Map<string, PromoContext>();
  for (const row of rows) {
    const key = buildPromoLookupKey(row.item_code, row.chain_id, row.store_id);
    const classified = classifyPromotionKind(row);

    result.set(key, {
      promotionId: row.promotion_id,
      promotionDescription: row.promotion_description,
      promoKind: classified.promoKind,
      promoLabel: classified.promoLabel,
      isConditionalPromo: classified.isConditionalPromo,
    });
  }

  return result;
}

export async function enrichApiOffersWithPromoContext(
  prisma: PrismaClient,
  offers: ApiOffer[],
): Promise<ApiOffer[]> {
  if (offers.length === 0) return offers;

  const contextMap = await resolvePromoContexts(
    prisma,
    offers.map((offer) => ({
      itemCode: offer.itemCode,
      chainId: offer.chainId,
      storeId: offer.storeId,
      promoPrice: offer.promoPrice,
    })),
  );

  return offers.map((offer) => {
    const key = buildPromoLookupKey(offer.itemCode, offer.chainId, offer.storeId);
    const context = contextMap.get(key);

    if (!context) {
      return {
        ...offer,
        promoKind: offer.promoPrice !== null ? 'regular' : null,
        promoLabel: offer.promoPrice !== null ? HEBREW_LABELS.regular : null,
        isConditionalPromo: false,
      };
    }

    return {
      ...offer,
      promotionId: context.promotionId,
      promotionDescription: context.promotionDescription,
      promoKind: context.promoKind,
      promoLabel: context.promoLabel,
      isConditionalPromo: context.isConditionalPromo,
    };
  });
}
