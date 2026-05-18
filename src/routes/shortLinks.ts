import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { createHash, randomInt, randomBytes } from 'crypto';
import { SHARE_IMAGE_HEIGHT, SHARE_IMAGE_WIDTH, parseShareLang } from '../utils/shareImage';

const router = Router();
const prisma = new PrismaClient();
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

type ShortShareKind = 'product' | 'promo' | 'promotions' | 'site' | 'list';

type ShortSharePayload = {
  kind?: string;
  title?: string;
  description?: string;
  redirectPath?: string;
  imagePath?: string;
  lang?: string;
};

type ShortShareRow = {
  code: string;
  kind: string;
  title: string;
  description: string | null;
  redirect_path: string;
  image_path: string;
  lang: string;
};

let tableReady: Promise<void> | null = null;

function esc(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

function getBackendBaseUrl(req: Request): string {
  if (process.env.BACKEND_BASE_URL) return process.env.BACKEND_BASE_URL;
  const protocol = req.headers['x-forwarded-proto']?.toString().split(',')[0] || req.protocol;
  const host = req.headers['x-forwarded-host']?.toString().split(',')[0] || req.get('host') || 'localhost:3001';
  return `${protocol}://${host}`;
}

function getShortBaseUrl(req: Request): string {
  return (process.env.SHARE_SHORT_BASE_URL || getBackendBaseUrl(req)).replace(/\/$/, '');
}

function normalizePath(raw: string | undefined, fallback: string): string {
  if (!raw) return fallback;
  const trimmed = raw.trim();
  if (!trimmed) return fallback;

  try {
    const url = new URL(trimmed);
    return `${url.pathname}${url.search}`;
  } catch {
    return trimmed.startsWith('/') ? trimmed : fallback;
  }
}

function absoluteBackendUrl(req: Request, pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  const path = pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`;
  return `${getBackendBaseUrl(req)}${path}`;
}

function absoluteFrontendUrl(pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  const frontendBase = (process.env.FRONTEND_URL || 'https://agali.live').replace(/\/$/, '');
  const path = pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`;
  return `${frontendBase}${path}`;
}

function generateCode(length = 7): string {
  let code = '';
  for (let i = 0; i < length; i++) {
    code += CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)];
  }
  return code;
}

function isShareKind(value: string): value is ShortShareKind {
  return value === 'product' || value === 'promo' || value === 'promotions' || value === 'site' || value === 'list';
}

async function ensureShareLinksTable(): Promise<void> {
  tableReady ??= (async () => {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS share_links (
        code TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        redirect_path TEXT NOT NULL,
        image_path TEXT NOT NULL,
        lang TEXT NOT NULL DEFAULT 'he',
        hit_count INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS share_links_created_at_idx ON share_links (created_at DESC)
    `);
  })();

  return tableReady;
}

async function insertShareLink(input: {
  kind: ShortShareKind;
  title: string;
  description: string;
  redirectPath: string;
  imagePath: string;
  lang: string;
}): Promise<string> {
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(input))
    .digest('hex');

  for (let attempts = 0; attempts < 8; attempts++) {
    const code = generateCode();
    try {
      const rows = await prisma.$queryRawUnsafe<{ code: string }[]>(
        `INSERT INTO share_links (code, fingerprint, kind, title, description, redirect_path, image_path, lang)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (fingerprint)
         DO UPDATE SET updated_at = NOW()
         RETURNING code`,
        code,
        fingerprint,
        input.kind,
        input.title,
        input.description,
        input.redirectPath,
        input.imagePath,
        input.lang,
      );
      return rows[0].code;
    } catch (error) {
      if (attempts === 7) throw error;
    }
  }

  throw new Error('Failed to create short share link');
}

router.post('/api/share-links', async (req: Request, res: Response) => {
  try {
    await ensureShareLinksTable();

    const body = req.body as ShortSharePayload;
    const kind = typeof body.kind === 'string' && isShareKind(body.kind) ? body.kind : null;
    const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 160) : 'Agali';
    const description = typeof body.description === 'string' ? body.description.trim().slice(0, 280) : '';
    const redirectPath = normalizePath(body.redirectPath, '/');
    const imagePath = normalizePath(body.imagePath, '/share/site/image?theme=dark&lang=he');
    const lang = parseShareLang(body.lang);

    if (!kind) return res.status(400).json({ error: 'Invalid share kind' });
    if (!redirectPath.startsWith('/')) return res.status(400).json({ error: 'Invalid redirect path' });
    if (!imagePath.startsWith('/')) return res.status(400).json({ error: 'Invalid image path' });

    const code = await insertShareLink({ kind, title, description, redirectPath, imagePath, lang });
    return res.status(201).json({
      code,
      url: `${getShortBaseUrl(req)}/s/${code}`,
    });
  } catch (error) {
    console.error('[POST /api/share-links]', error);
    return res.status(500).json({ error: 'Failed to create short share link' });
  }
});

router.get('/s/:code', async (req: Request, res: Response) => {
  const code = String(req.params.code).toLowerCase();

  try {
    await ensureShareLinksTable();

    const rows = await prisma.$queryRawUnsafe<ShortShareRow[]>(
      `SELECT code, kind, title, description, redirect_path, image_path, lang
       FROM share_links
       WHERE code = $1
       LIMIT 1`,
      code,
    );

    if (rows.length === 0) {
      return res.redirect(process.env.FRONTEND_URL || 'https://agali.live');
    }

    const row = rows[0];
    void prisma.$executeRawUnsafe(
      `UPDATE share_links SET hit_count = hit_count + 1, updated_at = NOW() WHERE code = $1`,
      code,
    ).catch((error) => console.error('[GET /s/:code hit_count]', error));

    const title = esc(row.title);
    const description = esc(row.description || 'Agali');
    const imageUrl = esc(absoluteBackendUrl(req, row.image_path));
    const rawRedirectUrl = absoluteFrontendUrl(row.redirect_path);
    const redirectUrl = esc(rawRedirectUrl);
    const shortUrl = esc(`${getShortBaseUrl(req)}/s/${row.code}`);
    const lang = parseShareLang(row.lang);

    const nonce = randomBytes(16).toString('base64');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; frame-ancestors 'none'`);
    return res.send(`<!DOCTYPE html>
<html lang="${lang}" dir="${lang === 'he' ? 'rtl' : 'ltr'}">
<head>
  <meta charset="utf-8" />
  <title>${title}</title>
  <meta property="og:type" content="website" />
  <meta property="og:title" content="${title}" />
  <meta property="og:description" content="${description}" />
  <meta property="og:image" content="${imageUrl}" />
  <meta property="og:image:type" content="image/png" />
  <meta property="og:image:width" content="${SHARE_IMAGE_WIDTH}" />
  <meta property="og:image:height" content="${SHARE_IMAGE_HEIGHT}" />
  <meta property="og:url" content="${shortUrl}" />
  <meta property="og:site_name" content="Agali" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${title}" />
  <meta name="twitter:description" content="${description}" />
  <meta name="twitter:image" content="${imageUrl}" />
  <meta http-equiv="refresh" content="0;url=${redirectUrl}" />
</head>
<body>
  <script nonce="${nonce}">window.location.replace(${JSON.stringify(rawRedirectUrl)});</script>
  <p>Redirecting...</p>
</body>
</html>`);
  } catch (error) {
    console.error('[GET /s/:code]', error);
    return res.redirect(process.env.FRONTEND_URL || 'https://agali.live');
  }
});

export default router;
