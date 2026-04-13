import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import type { ServerResponse } from 'http';

const router = Router();
const prisma = new PrismaClient();

// ─── In-memory SSE pub/sub ─────────────────────────────────────────────────
// Map: code → Set of active SSE response streams
const subscribers = new Map<string, Set<Response>>();

function subscribe(code: string, res: Response) {
  if (!subscribers.has(code)) subscribers.set(code, new Set());
  subscribers.get(code)!.add(res);
}

function unsubscribe(code: string, res: Response) {
  const subs = subscribers.get(code);
  if (!subs) return;
  subs.delete(res);
  if (subs.size === 0) subscribers.delete(code);
}

function broadcast(code: string, payload: object) {
  const subs = subscribers.get(code);
  if (!subs) return;
  const data = `event: list_updated\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of subs) {
    try { res.write(data); } catch { /* client disconnected */ }
  }
}

// ─── Code generator: 5 chars alphanum sans ambiguïtés (sans O/0/I/1) ──────
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generateCode(): string {
  let code = '';
  for (let i = 0; i < 5; i++) {
    code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return code;
}

async function generateUniqueCode(): Promise<string> {
  for (let attempts = 0; attempts < 10; attempts++) {
    const code = generateCode();
    const existing = await prisma.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id FROM shopping_lists WHERE code = $1 LIMIT 1`, code
    );
    if (existing.length === 0) return code;
  }
  throw new Error('Failed to generate unique code');
}

// ─── POST /api/lists — créer une nouvelle liste ────────────────────────────
router.post('/', async (req: Request, res: Response) => {
  try {
    const { name = 'רשימת קניות', items = [] } = req.body;

    if (!Array.isArray(items)) {
      return res.status(400).json({ error: 'items must be an array' });
    }

    const code = await generateUniqueCode();

    const result = await prisma.$queryRawUnsafe<{ id: string; code: string; name: string }[]>(
      `INSERT INTO shopping_lists (code, name, items)
       VALUES ($1, $2, $3::jsonb)
       RETURNING id, code, name`,
      code,
      name,
      JSON.stringify(items)
    );

    return res.status(201).json(result[0]);
  } catch (err) {
    console.error('[POST /api/lists]', err);
    return res.status(500).json({ error: 'שגיאה ביצירת הרשימה' });
  }
});

// ─── GET /api/lists/:code — lire une liste ─────────────────────────────────
router.get('/:code', async (req: Request, res: Response) => {
  try {
    const { code } = req.params;
    if (!code || code.length !== 5) {
      return res.status(400).json({ error: 'קוד לא תקין' });
    }

    const rows = await prisma.$queryRawUnsafe<{
      id: string; code: string; name: string; items: any; updated_at: string;
    }[]>(
      `SELECT id, code, name, items, updated_at FROM shopping_lists WHERE code = $1 LIMIT 1`,
      code.toUpperCase()
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'רשימה לא נמצאה' });
    }

    return res.json(rows[0]);
  } catch (err) {
    console.error('[GET /api/lists/:code]', err);
    return res.status(500).json({ error: 'שגיאה בטעינת הרשימה' });
  }
});

// ─── PATCH /api/lists/:code — mettre à jour items + broadcast ─────────────
router.patch('/:code', async (req: Request, res: Response) => {
  try {
    const { code } = req.params;
    const { items, name } = req.body;

    if (!code || code.length !== 5) {
      return res.status(400).json({ error: 'קוד לא תקין' });
    }

    const setClauses: string[] = [];
    const values: any[] = [];
    let idx = 1;

    if (Array.isArray(items)) {
      setClauses.push(`items = $${idx}::jsonb`);
      values.push(JSON.stringify(items));
      idx++;
    }
    if (name && typeof name === 'string') {
      setClauses.push(`name = $${idx}`);
      values.push(name);
      idx++;
    }

    if (setClauses.length === 0) {
      return res.status(400).json({ error: 'אין שינויים לשמור' });
    }

    values.push(code.toUpperCase());
    const query = `UPDATE shopping_lists SET ${setClauses.join(', ')} WHERE code = $${idx} RETURNING id, code, name, items, updated_at`;

    const rows = await prisma.$queryRawUnsafe<{
      id: string; code: string; name: string; items: any; updated_at: string;
    }[]>(query, ...values);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'רשימה לא נמצאה' });
    }

    const updated = rows[0];
    // Broadcast to all SSE subscribers for this code
    broadcast(code.toUpperCase(), { type: 'list_updated', ...updated });

    return res.json(updated);
  } catch (err) {
    console.error('[PATCH /api/lists/:code]', err);
    return res.status(500).json({ error: 'שגיאה בעדכון הרשימה' });
  }
});

// ─── GET /api/lists/:code/stream — SSE live updates ───────────────────────
router.get('/:code/stream', (req: Request, res: Response) => {
  const { code } = req.params;
  if (!code || code.length !== 5) {
    res.status(400).end();
    return;
  }

  const upperCode = code.toUpperCase();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Send keepalive ping every 25s to prevent proxy timeouts
  const keepalive = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* closed */ }
  }, 25000);

  subscribe(upperCode, res);

  // Send initial connected event
  res.write(`event: connected\ndata: ${JSON.stringify({ code: upperCode })}\n\n`);

  req.on('close', () => {
    clearInterval(keepalive);
    unsubscribe(upperCode, res);
  });
});

export default router;
