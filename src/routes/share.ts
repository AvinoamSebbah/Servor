import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { getCatalogImageUrl } from '../utils/media';

const router = Router();
const prisma = new PrismaClient();

// Use the first catalog product image as the OG preview.
function buildOgImageUrl(productIds: string[]): string {
  const ids = productIds.filter(Boolean);
  const bgId = ids[0] || 'p_01_01_001';
  return getCatalogImageUrl(bgId) ?? '';
}

// Escape HTML entities to prevent injection in the OG HTML page
function esc(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// GET /share/:code — returns an HTML page with OG meta tags then redirects to the frontend
router.get('/:code', async (req: Request, res: Response) => {
  const { code } = req.params;
  const FRONTEND_URL = process.env.FRONTEND_URL || 'https://agali.live';
  const redirectTarget = `${FRONTEND_URL}/shopping-list/run/${code.toUpperCase()}`;

  try {
    const rows = await prisma.$queryRawUnsafe<{ name: string; items: unknown }[]>(
      `SELECT name, items FROM shopping_lists WHERE code = $1 LIMIT 1`,
      code.toUpperCase()
    );

    if (rows.length === 0) {
      return res.redirect(redirectTarget);
    }

    const { name, items } = rows[0];
    // items may come as already-parsed object or as string from Prisma JSONB
    const rawItems = typeof items === 'string' ? JSON.parse(items) : items;
    const itemsArr: Array<{ productId?: string }> = Array.isArray(rawItems) ? rawItems : [];
    const count = itemsArr.length;
    const productIds = itemsArr.slice(0, 4).map((i) => i.productId ?? '').filter(Boolean);

    const ogImage = buildOgImageUrl(productIds);
    const title = esc(`🛒 ${name}`);
    const description = esc(
      count > 0
        ? `${count} מוצרים | לחצו להצטרף לרשימה ב-Agali`
        : 'רשימת קניות שיתופית ב-Agali'
    );
    const safeRedirect = esc(redirectTarget);
    const safeImage = esc(ogImage);

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    // Cache for 60s so WhatsApp scraper gets fresh data
    res.setHeader('Cache-Control', 'public, max-age=60');

    return res.send(`<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="utf-8" />
  <title>${title}</title>
  <meta property="og:type" content="website" />
  <meta property="og:title" content="${title}" />
  <meta property="og:description" content="${description}" />
  <meta property="og:image" content="${safeImage}" />
  <meta property="og:image:type" content="image/jpeg" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:url" content="${safeRedirect}" />
  <meta property="og:site_name" content="Agali" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${title}" />
  <meta name="twitter:description" content="${description}" />
  <meta name="twitter:image" content="${safeImage}" />
  <meta http-equiv="refresh" content="0;url=${safeRedirect}" />
</head>
<body>
  <script>window.location.replace("${safeRedirect}");</script>
  <p>מעביר אותך לרשימה...</p>
</body>
</html>`);
  } catch (err) {
    console.error('[GET /share/:code]', err);
    return res.redirect(redirectTarget);
  }
});

export default router;
