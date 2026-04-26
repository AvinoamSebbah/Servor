export type RawOfferRow = {
  item_code: string;
  item_name: string | null;
  manufacturer_name: string | null;
  chain_id: string;
  chain_name?: string | null;
  store_id: string;
  store_name: string | null;
  city: string | null;
  price: unknown;
  promo_price: unknown;
  effective_price: unknown;
  unit_of_measure?: string | null;
  unit_qty?: string | null;
  b_is_weighted?: unknown;
  promotion_id?: string | null;
  promotion_description?: string | null;
  promo_kind?: string | null;
  promo_label?: string | null;
  is_conditional_promo?: unknown;
  updated_at: Date | string | null;
};

export type ApiOffer = {
  itemCode: string;
  itemName: string | null;
  manufacturerName: string | null;
  chainId: string;
  chainName?: string | null;
  storeId: string;
  storeName: string | null;
  city: string | null;
  price: number | null;
  promoPrice: number | null;
  effectivePrice: number | null;
  unitOfMeasure?: string | null;
  unitQty?: string | null;
  bIsWeighted?: boolean;
  promotionId?: string | null;
  promotionDescription?: string | null;
  promoKind?: string | null;
  promoLabel?: string | null;
  isConditionalPromo?: boolean;
  updatedAt: string | null;
};

type LegacyDetailShape = {
  prices: Array<{
    id: string;
    chainId: string;
    itemCode: string;
    itemPrice: string;
    basePrice: string;
    priceUpdateDate: string | null;
      unitOfMeasure: string | null;
      unitQty: string | null;
      bIsWeighted: boolean;
    store: {
      id: number;
      chainId: string;
      storeId: string;
      chainName: string;
      storeName: string;
      city: string;
    };
  }>;
  promotions: Array<{
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
  }>;
  bestPrice: number | null;
  bestEffectivePrice: number | null;
  hasPromo: boolean;
};

const CHAIN_ID_TO_NAME: Record<string, string> = {
  '5144744100002': 'משנת יוסף - קיי טי יבוא ושיווק בע"מ',
  '7290000000003': 'סיטי מרקט',
  '7290027600007': 'שופרסל שלי',
  '7290058134977': 'שפע ברכת השם בע"מ',
  '7290058140886': 'רמי לוי שיווק השקמה',
  '7290058148776': 'שוק העיר (ט.ע.מ.ס.) בע"מ',
  '7290058156016': 'סופר ספיר בע"מ',
  '7290058159628': 'ג.מ. מעיין אלפיים (07) בע"מ',
  '7290058160839': 'נתיב החסד- סופר חסד בע"מ',
  '7290058173198': 'זול ובגדול בע"מ',
  '7290058177776': 'סופר יודה',
  '7290058197699': 'גוד פארם בע"מ',
  '7290058249350': 'וולט מרקט',
  '7290058266241': 'סיטי צפריר בע"מ',
  '7290058289400': 'קי טי יבוא ושווק בע"מ',
  '7290103152017': 'אושר עד',
  '7290492000005': 'Dor Alon',
  '7290526500006': 'Dabach',
  '7290639000004': 'סטופמרקט',
  '7290644700005': 'פז קמעונאות ואנרגיה בע"מ',
  '7290803800003': 'מ. יוחננוף ובניו',
  '7290873255550': 'טיב טעם',
  '7290875100001': 'סופר ברקת קמעונאות בע"מ',
  '7290876100000': 'פרש מרקט',
  '7291056200008': 'רמי לוי בשכונה',
  '7291059100008': 'פוליצר',
  '999': 'SmokeTestChain',
};

function resolveChainName(chainId: string): string {
  return CHAIN_ID_TO_NAME[chainId] ?? chainId;
}

export function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  const parsed = Number(String(value).trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function toBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) && value !== 0;

  const normalized = String(value ?? '').trim().toLowerCase();
  return ['1', 'true', 't', 'yes', 'y'].includes(normalized);
}

export function mapOfferRow(row: RawOfferRow): ApiOffer {
  return {
    itemCode: row.item_code,
    itemName: row.item_name,
    manufacturerName: row.manufacturer_name,
    chainId: row.chain_id,
    chainName: row.chain_name ?? null,
    storeId: row.store_id,
    storeName: row.store_name,
    city: row.city,
    price: toNullableNumber(row.price),
    promoPrice: toNullableNumber(row.promo_price),
    effectivePrice: toNullableNumber(row.effective_price),
    unitOfMeasure: row.unit_of_measure ?? null,
    unitQty: row.unit_qty ?? null,
    bIsWeighted: toBoolean(row.b_is_weighted),
    promotionId: row.promotion_id ?? null,
    promotionDescription: row.promotion_description ?? null,
    promoKind: row.promo_kind ?? null,
    promoLabel: row.promo_label ?? null,
    isConditionalPromo: toBoolean(row.is_conditional_promo),
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

export function mapOffersToLegacyDetails(offers: ApiOffer[]): LegacyDetailShape {
  const prices: LegacyDetailShape['prices'] = [];
  const promotions: LegacyDetailShape['promotions'] = [];
  let bestPrice: number | null = null;
  let bestEffectivePrice: number | null = null;

  offers.forEach((offer, index) => {
    const numericStoreId = Number.parseInt(offer.storeId, 10);
    const priceValue = offer.price;
    const promoValue = offer.promoPrice;

    if (priceValue !== null && (bestPrice === null || priceValue < bestPrice)) {
      bestPrice = priceValue;
    }

    if (offer.effectivePrice !== null) {
      if (bestEffectivePrice === null || offer.effectivePrice < bestEffectivePrice) {
        bestEffectivePrice = offer.effectivePrice;
      }
    }

    prices.push({
      id: `${offer.itemCode}-${offer.storeId}-${index}`,
      chainId: offer.chainId,
      itemCode: offer.itemCode,
      itemPrice: priceValue !== null ? priceValue.toString() : '0',
      basePrice: priceValue !== null ? priceValue.toString() : '0',
      priceUpdateDate: offer.updatedAt,
      unitOfMeasure: offer.unitOfMeasure ?? null,
      unitQty: offer.unitQty ?? null,
      bIsWeighted: Boolean(offer.bIsWeighted),
      store: {
        id: Number.isFinite(numericStoreId) ? numericStoreId : 0,
        chainId: offer.chainId,
        storeId: offer.storeId,
        chainName: offer.chainName || resolveChainName(offer.chainId),
        storeName: offer.storeName ?? (offer.chainName || resolveChainName(offer.chainId)),
        city: offer.city ?? '',
      },
    });

    if (promoValue !== null && priceValue !== null && promoValue < priceValue) {
      promotions.push({
        id: `${offer.itemCode}-${offer.storeId}-${index}-promo`,
        promotion_id: offer.promotionId ?? `promo-${offer.chainId}-${offer.storeId}`,
        promotion_description: offer.promotionDescription ?? null,
        promotion_start_date: '1970-01-01',
        promotion_end_date: '2999-12-31',
        club_id: null,
        chain_id: offer.chainId,
        discounted_price: promoValue.toString(),
        discount_rate: null,
        min_qty: null,
        max_qty: null,
        available_in_store_ids: [offer.storeId],
        matched_item_code: offer.itemCode,
        promotion_type: offer.promoKind ?? null,
        promotion_badge_label: offer.promoLabel ?? null,
        is_conditional_promo: Boolean(offer.isConditionalPromo),
      });
    }
  });

  return {
    prices,
    promotions,
    bestPrice,
    bestEffectivePrice,
    hasPromo: promotions.length > 0,
  };
}

export function buildOffsetPagination(limit: number, offset: number, resultCount: number) {
  const safeLimit = Math.max(1, limit);
  const page = Math.floor(Math.max(0, offset) / safeLimit) + 1;
  const hasMore = resultCount === safeLimit;

  return {
    limit: safeLimit,
    offset: Math.max(0, offset),
    page,
    hasMore,
    totalPages: hasMore ? page + 1 : page,
  };
}