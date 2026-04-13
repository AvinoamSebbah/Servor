import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';

const router = Router();
const prisma = new PrismaClient();

const CLOUD_NAME = 'dprve5nst';

// Build a Cloudinary OG image URL from product IDs (1 image = full-width, 4 = 2x2 grid)
function buildOgImageUrl(productIds: string[]): string {
  const base = `https://res.cloudinary.com/${CLOUD_NAME}/image/upload`;
  const ids = productIds.filter(Boolean).slice(0, 4);

  if (ids.length === 0) {
    return `${base}/c_fill,w_1200,h_630,g_auto/f_auto,q_80/catalog/p_01_01_001`;
  }

  if (ids.length < 4) {
    return `${base}/c_fill,w_1200,h_630,g_auto/f_auto,q_80/catalog/${ids[0]}`;
  }

  // 4-image 2×2 grid: each quadrant 600×315
  // In Cloudinary layer refs, folder '/' → ':'
  const safe = ids.map((id) => `catalog:${id}`);

  return [
    base,
    `c_fill,w_1200,h_630,b_rgb:0f172a`,
    `l_${safe[0]}/c_fill,w_600,h_315,fl_layer_apply,g_north_west`,
    `l_${safe[1]}/c_fill,w_600,h_315,fl_layer_apply,g_north_east`,
    `l_${safe[2]}/c_fill,w_600,h_315,fl_layer_apply,g_south_west`,
    `l_${safe[3]}/c_fill,w_600,h_315,fl_layer_apply,g_south_east`,
    `f_auto,q_80`,
    `catalog/${ids[0]}`,
  ].join('/');
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
  const FRONTEND_URL = process.env.FRONTEND_URL || 'https://agali-app.vercel.app';
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
    const itemsArr: Array<{ productId?: string }> = Array.isArray(items) ? items as Array<{ productId?: string }> : [];
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
