require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

function getArg(name, fallback = '') {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}

async function main() {
  const itemCode = getArg('--item', '');
  const chainId = getArg('--chain', '');
  const storeId = getArg('--store', '');
  const cityPrefix = getArg('--city-prefix', '');

  if (!itemCode || !chainId || !storeId) {
    console.error('Usage: node scripts/inspect_promo_item.js --item <barcode> --chain <chainId> --store <storeId> [--city-prefix <city%>]');
    process.exitCode = 2;
    return;
  }

  await prisma.$executeRawUnsafe("SET statement_timeout = '15000'");

  const productRows = await prisma.$queryRaw`
    SELECT id, item_code, item_name, manufacturer_name
    FROM products
    WHERE item_code = ${itemCode}
    LIMIT 1
  `;

  if (!productRows.length) {
    console.log(JSON.stringify({ error: 'product_not_found', itemCode }, null, 2));
    return;
  }

  const product = productRows[0];
  const productId = product.id;

  const psiStoreRows = await prisma.$queryRaw`
    SELECT
      psi.chain_id,
      psi.promotion_id,
      s.store_id,
      s.store_name,
      s.city,
      psi.promo_price,
      psi.promotion_end_date,
      psi.updated_at
    FROM promotion_store_items psi
    JOIN stores s ON s.id = psi.store_id
    WHERE psi.product_id = ${productId}
      AND psi.chain_id = ${chainId}
      AND s.store_id = ${storeId}
    ORDER BY psi.updated_at DESC
    LIMIT 50
  `;

  const psiChainSummary = await prisma.$queryRaw`
    SELECT
      psi.promotion_id,
      COUNT(*)::int AS store_rows,
      MIN(psi.promo_price) AS min_promo_price,
      MAX(psi.promo_price) AS max_promo_price,
      MAX(psi.updated_at) AS last_seen
    FROM promotion_store_items psi
    JOIN stores s ON s.id = psi.store_id
    WHERE psi.product_id = ${productId}
      AND psi.chain_id = ${chainId}
      AND (
        ${cityPrefix} = ''
        OR s.city ILIKE ${cityPrefix}
      )
    GROUP BY psi.promotion_id
    ORDER BY store_rows DESC, last_seen DESC
    LIMIT 50
  `;

  const promoItemRows = await prisma.$queryRaw`
    WITH target_promos AS (
      SELECT DISTINCT psi.chain_id, psi.promotion_id
      FROM promotion_store_items psi
      JOIN stores s ON s.id = psi.store_id
      WHERE psi.product_id = ${productId}
        AND psi.chain_id = ${chainId}
        AND s.store_id = ${storeId}
    )
    SELECT
      p.chain_id,
      p.promotion_id,
      p.promotion_description,
      p.promotion_start_date,
      p.promotion_end_date,
      p.club_id,
      p.reward_type,
      p.additional_is_coupon,
      p.additional_restrictions,
      p.remarks,
      p.redemption_limit,
      p.allow_multiple_discounts,
      p.is_weighted_promo,
      p.min_qty,
      p.discounted_price,
      p.discounted_price_per_mida,
      p.weight_unit,
      p.updated_at,
      LEFT(COALESCE(p.items::text, ''), 600) AS items_excerpt,
      COALESCE(obj.obj->>'itemcode', obj.obj->>'ItemCode') AS item_code,
      obj.obj->>'rewardtype' AS rewardtype_lc,
      obj.obj->>'RewardType' AS rewardtype_uc,
      obj.obj->>'minqty' AS minqty_lc,
      obj.obj->>'MinQty' AS minqty_uc,
      obj.obj->>'maxqty' AS maxqty_lc,
      obj.obj->>'MaxQty' AS maxqty_uc,
      obj.obj->>'discountrate' AS discountrate_lc,
      obj.obj->>'DiscountRate' AS discountrate_uc,
      obj.obj->>'discountedprice' AS discountedprice_lc,
      obj.obj->>'DiscountedPrice' AS discountedprice_uc,
      obj.obj->>'discountedpricepermida' AS discountedpricepermida_lc,
      obj.obj->>'DiscountedPricePerMida' AS discountedpricepermida_uc,
      obj.obj->>'bisweighted' AS bisweighted_lc,
      obj.obj->>'bIsWeighted' AS bisweighted_uc
    FROM promotions p
    JOIN target_promos tp
      ON tp.chain_id = p.chain_id
     AND tp.promotion_id = p.promotion_id
    JOIN LATERAL (
      SELECT q.val AS obj
      FROM jsonb_path_query(COALESCE(p.items, '[]'::jsonb), '$.**') AS q(val)
      WHERE jsonb_typeof(q.val) = 'object'
        AND COALESCE(q.val->>'itemcode', q.val->>'ItemCode') = ${itemCode}
    ) obj ON TRUE
    ORDER BY p.updated_at DESC
    LIMIT 50
  `;

  const cacheRows = await prisma.$queryRaw`
    SELECT
      scope_type,
      city,
      chain_id,
      store_id,
      rank_position,
      price,
      promo_price,
      effective_price,
      discount_percent,
      smart_score,
      promotion_end_date,
      updated_at
    FROM top_promotions_cache
    WHERE window_hours = 24
      AND chain_id = ${chainId}
      AND store_id = ${storeId}
      AND item_code = ${itemCode}
      AND (
        ${cityPrefix} = ''
        OR city ILIKE ${cityPrefix}
      )
    ORDER BY scope_type, rank_position
    LIMIT 50
  `;

  console.log(
    JSON.stringify(
      {
        product,
        psiStoreRows,
        psiChainSummary,
        promoItemRows,
        cacheRows,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
