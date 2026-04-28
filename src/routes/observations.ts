import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';

const router = Router();
const prisma = new PrismaClient();

// ── Auth helper (same pattern as auth.ts) ─────────────────────────────────────

async function getUserByToken(token: string) {
  if (!token) return null;
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT u.*
     FROM auth_tokens at
     JOIN users u ON u.id = at.user_id
     WHERE at.token = $1 AND at.expires_at > NOW()`,
    token
  );
  return rows[0] || null;
}

function extractToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice(7).trim() || null;
}

// ── GET /api/observations ─────────────────────────────────────────────────────
// List current user's active observations

router.get('/', async (req: Request, res: Response) => {
  const token = extractToken(req);
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const user = await getUserByToken(token);
  if (!user) return res.status(401).json({ error: 'Invalid or expired session' });

  try {
    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT o.id, o.item_code, o.city, o.store_id, o.min_discount_pct,
              o.status, o.expires_at, o.created_at,
              p.item_name
       FROM observations o
       JOIN products p ON p.id = o.product_id
       WHERE o.user_id = $1
       ORDER BY o.created_at DESC`,
      user.id
    );
    return res.json({ observations: rows });
  } catch (error) {
    console.error('GET /observations error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/observations/:itemCode/status ────────────────────────────────────
// Returns bell state for a given product barcode + city

router.get('/:itemCode/status', async (req: Request, res: Response) => {
  const token = extractToken(req);
  if (!token) return res.json({ active: false, status: null, min_discount_pct: null });

  const user = await getUserByToken(token);
  if (!user) return res.json({ active: false, status: null, min_discount_pct: null });

  const { itemCode } = req.params;
  const city = (req.query.city as string) || '';

  try {
    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT o.status, o.min_discount_pct, o.expires_at
       FROM observations o
       JOIN products p ON p.id = o.product_id
       WHERE o.user_id = $1 AND o.item_code = $2 AND o.city = $3
       LIMIT 1`,
      user.id,
      itemCode,
      city
    );
    if (!rows.length) return res.json({ active: false, status: null, min_discount_pct: null });
    const row = rows[0];
    return res.json({
      active: row.status === 'active',
      status: row.status,
      min_discount_pct: parseFloat(row.min_discount_pct),
    });
  } catch (error) {
    console.error('GET /observations/:itemCode/status error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/observations ────────────────────────────────────────────────────
// Upsert observation (create or update min_discount_pct)

router.post('/', async (req: Request, res: Response) => {
  const token = extractToken(req);
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const user = await getUserByToken(token);
  if (!user) return res.status(401).json({ error: 'Invalid or expired session' });

  const { item_code, city, min_discount_pct, store_id, base_price, target_price } = req.body;

  if (!item_code || typeof item_code !== 'string') {
    return res.status(400).json({ error: 'item_code is required' });
  }
  if (!city || typeof city !== 'string') {
    return res.status(400).json({ error: 'city is required' });
  }
  const pct = parseFloat(min_discount_pct);
  if (!Number.isFinite(pct) || pct < 1 || pct > 100) {
    return res.status(400).json({ error: 'min_discount_pct must be between 1 and 100' });
  }
  const basePriceVal = base_price != null ? parseFloat(base_price) : null;
  const targetPriceVal = target_price != null ? parseFloat(target_price) : null;

  try {
    // Resolve product_id from item_code
    const products = await prisma.$queryRawUnsafe<any[]>(
      `SELECT id FROM products WHERE item_code = $1 LIMIT 1`,
      item_code
    );
    if (!products.length) {
      return res.status(404).json({ error: 'Product not found' });
    }
    const productId = products[0].id;

    await prisma.$executeRawUnsafe(
      `INSERT INTO observations
         (user_id, product_id, item_code, city, store_id, min_discount_pct, base_price, target_price, status, expires_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', NOW() + INTERVAL '6 months', NOW())
       ON CONFLICT ON CONSTRAINT observations_user_product_city_unique
       DO UPDATE SET
         min_discount_pct = EXCLUDED.min_discount_pct,
         base_price       = EXCLUDED.base_price,
         target_price     = EXCLUDED.target_price,
         store_id         = EXCLUDED.store_id,
         status           = 'active',
         expires_at       = NOW() + INTERVAL '6 months',
         updated_at       = NOW()`,
      user.id,
      productId,
      item_code,
      city,
      store_id ?? null,
      pct,
      basePriceVal,
      targetPriceVal
    );

    return res.status(201).json({ success: true });
  } catch (error) {
    console.error('POST /observations error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── PATCH /api/observations/:itemCode ────────────────────────────────────────
// Update status (active | paused | stopped)

router.patch('/:itemCode', async (req: Request, res: Response) => {
  const token = extractToken(req);
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const user = await getUserByToken(token);
  if (!user) return res.status(401).json({ error: 'Invalid or expired session' });

  const { itemCode } = req.params;
  const { status, city } = req.body;

  const VALID_STATUSES = ['active', 'paused', 'stopped'];
  if (!VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
  }
  if (!city) return res.status(400).json({ error: 'city is required' });

  try {
    const result = await prisma.$executeRawUnsafe(
      `UPDATE observations
       SET status = $1, updated_at = NOW()
       WHERE user_id = $2 AND item_code = $3 AND city = $4`,
      status,
      user.id,
      itemCode,
      city
    );
    if (!result) return res.status(404).json({ error: 'Observation not found' });
    return res.json({ success: true, status });
  } catch (error) {
    console.error('PATCH /observations/:itemCode error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── DELETE /api/observations/:itemCode ────────────────────────────────────────
// Hard delete observation

router.delete('/:itemCode', async (req: Request, res: Response) => {
  const token = extractToken(req);
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const user = await getUserByToken(token);
  if (!user) return res.status(401).json({ error: 'Invalid or expired session' });

  const { itemCode } = req.params;
  const city = (req.query.city as string) || '';

  try {
    await prisma.$executeRawUnsafe(
      `DELETE FROM observations WHERE user_id = $1 AND item_code = $2 AND city = $3`,
      user.id,
      itemCode,
      city
    );
    return res.json({ success: true });
  } catch (error) {
    console.error('DELETE /observations/:itemCode error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
