import { Router } from 'express';
import { PrismaClient, Prisma } from '@prisma/client';
import { mapOfferRow } from '../services/offerMapping';

const router = Router();
const prisma = new PrismaClient();

// POST /api/compare - Compare prices across stores
router.post('/', async (req, res) => {
  const tRouteStart = process.hrtime.bigint();
  const timingsMs: Record<string, number> = {};
  try {
    const rawProducts = req.body?.products;
    const city = typeof req.query.city === 'string' ? req.query.city.trim() : '';

    if (!rawProducts || !Array.isArray(rawProducts) || rawProducts.length === 0) {
      return res.status(400).json({ error: 'Products array required' });
    }

    // Limit and sanitize products list
    const products = rawProducts.slice(0, 50).map((p: any) => ({
      itemCode: String(p.itemCode || '').trim(),
      quantity: Number.isFinite(Number(p.quantity)) ? Math.max(1, Number(p.quantity)) : 1,
      itemName: p.itemName ?? null,
    })).filter((p: any) => p.itemCode);

    if (!products.length) return res.status(400).json({ error: 'No valid products' });

    const barcodes = products.map((p: any) => p.itemCode);

    // Fetch offers using the DB function that expands offers per store
    const tOffersSql = process.hrtime.bigint();
    const offersRowsRaw: any[] = await prisma.$queryRaw(Prisma.sql`
      WITH input_codes AS (
        SELECT unnest(${barcodes}::text[]) AS item_code
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
        NULL::text,
        ${50}::integer,
        0::integer
      ) o
      LEFT JOIN LATERAL (
        SELECT chain_name FROM stores WHERE chain_id = o.chain_id AND store_id = o.store_id LIMIT 1
      ) s_name ON true
      ORDER BY o.item_code ASC, o.effective_price ASC NULLS LAST, o.updated_at DESC NULLS LAST, o.store_id ASC
    `);
    timingsMs.offersSql = Number(process.hrtime.bigint() - tOffersSql) / 1_000_000;

    // Normalize offers using mapOfferRow
    const mappedOffers = offersRowsRaw.map(mapOfferRow);

    // Group offers by store and pick cheapest offer per item per store
    const tGroup = process.hrtime.bigint();
    const storeMap2 = new Map<string, any>();
    for (const row of mappedOffers) {
      const storeKey = String(row.storeId);
      if (!storeMap2.has(storeKey)) {
        storeMap2.set(storeKey, {
          storeId: row.storeId,
          storeName: row.storeName,
          chainId: row.chainId,
          chainName: row.chainName,
          city: row.city,
          sampleOffer: row,
          itemsMap: new Map<string, any>(),
        });
      }
      const entry = storeMap2.get(storeKey)!;
      const code = row.itemCode;
      const priceVal = row.effectivePrice ?? row.promoPrice ?? row.price;
      const existing = entry.itemsMap.get(code);
      const numericPrice = typeof priceVal === 'number' ? priceVal : (priceVal === null ? null : Number(priceVal));
      if (numericPrice === null || !Number.isFinite(numericPrice)) continue;
      if (!existing || numericPrice < existing.price) {
        entry.itemsMap.set(code, {
          itemCode: code,
          itemName: row.itemName,
          price: numericPrice,
          hasPromo: row.promoPrice != null,
          originalPrice: row.price != null ? (typeof row.price === 'number' ? row.price : Number(row.price)) : undefined,
        });
      }
    }
    timingsMs.group = Number(process.hrtime.bigint() - tGroup) / 1_000_000;

    // Convert per-store itemsMap into items array and compute totals
    const totalRequested = products.length;
    const result: any[] = [];
    for (const [storeDbId, entry] of storeMap2.entries()) {
      const itemsArr: any[] = [];
      let totalPrice = 0;
      for (const [code, it] of entry.itemsMap.entries()) {
        const qty = products.find((p: any) => p.itemCode === code)?.quantity || 1;
        itemsArr.push({
          itemCode: it.itemCode,
          itemName: it.itemName,
          price: it.price,
          quantity: qty,
          hasPromo: !!it.hasPromo,
          originalPrice: it.originalPrice,
        });
        totalPrice += (it.price ?? 0) * qty;
      }
      if (itemsArr.length === 0) continue;
      // derive chainName directly from the store row (chain_name from DB)
      const chainName = entry.chainName || entry.chainId || '';

      result.push({
        storeId: Number(storeDbId),
        storeName: entry.storeName,
        chainId: entry.chainId,
        chainName,
        city: entry.city,
        totalPrice,
        items: itemsArr,
      });
    }

    // sort and compute coverage
    const sorted = result
      .map((s) => ({ ...s, coverage: Math.round((s.items.length / totalRequested) * 100) }))
      .sort((a, b) => (b.coverage !== a.coverage ? b.coverage - a.coverage : a.totalPrice - b.totalPrice));

    timingsMs.total = Number(process.hrtime.bigint() - tRouteStart) / 1_000_000;
    res.setHeader('Server-Timing', Object.entries(timingsMs).map(([k, v]) => `${k};dur=${v.toFixed(1)}`).join(', '));

    // safeJson: convert BigInt to Number and deep-copy
    function safeJson(obj: any): any {
      if (Array.isArray(obj)) return obj.map(safeJson);
      if (obj && typeof obj === 'object') {
        const out: { [k: string]: any } = {};
        for (const [k, v] of Object.entries(obj)) {
          if (typeof v === 'bigint') out[k] = Number(v);
          else out[k] = safeJson(v);
        }
        return out;
      }
      return obj;
    }

    console.info('perf.compare', { count: sorted.length, timingsMs });
    return res.json({ stores: safeJson(sorted) });
  } catch (error) {
    if (error instanceof Error) {
      console.error('[compare] error', { message: error.message, stack: error.stack, errorObj: error });
    } else {
      console.error('[compare] unknown error', error);
    }
    return res.status(500).json({ error: 'Internal server error', detail: String(error) });
  }
});

export default router;

