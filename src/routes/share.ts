import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { getCatalogImageUrl } from '../utils/media';
import {
  generateProductShareImage,
  getProductShareMeta,
  parseShareLang,
  parseShareTheme,
  SHARE_IMAGE_HEIGHT,
  SHARE_IMAGE_WIDTH,
} from '../utils/shareImage';

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

function getBackendBaseUrl(req: Request): string {
  const protocol = req.headers['x-forwarded-proto']?.toString().split(',')[0] || req.protocol;
  const host = req.headers['x-forwarded-host']?.toString().split(',')[0] || req.get('host') || 'localhost:3001';
  return `${protocol}://${host}`;
}

router.get('/product/:barcode/image', async (req: Request, res: Response) => {
  const { barcode } = req.params;
  const city = typeof req.query.city === 'string' ? req.query.city.trim() : '';
  const theme = parseShareTheme(req.query.theme);
  const lang = parseShareLang(req.query.lang);

  try {
    const png = await generateProductShareImage(prisma, barcode, city, theme, lang);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.send(png);
  } catch (error) {
    console.error('[GET /share/product/:barcode/image]', error);
    return res.status(500).json({ error: 'Failed to generate share image' });
  }
});

router.get('/product/:barcode', async (req: Request, res: Response) => {
  const { barcode } = req.params;
  const city = typeof req.query.city === 'string' ? req.query.city.trim() : '';
  const theme = parseShareTheme(req.query.theme);
  const lang = parseShareLang(req.query.lang);
  const FRONTEND_URL = process.env.FRONTEND_URL || 'https://agali.live';
  const redirectTarget = `${FRONTEND_URL}/product/${encodeURIComponent(barcode)}`;

  try {
    const meta = await getProductShareMeta(prisma, barcode, city);
    const backendBaseUrl = getBackendBaseUrl(req);
    const params = new URLSearchParams();
    if (city) params.set('city', city);
    params.set('theme', theme);
    params.set('lang', lang);
    const imageUrl = `${backendBaseUrl}/share/product/${encodeURIComponent(barcode)}/image?${params.toString()}`;

    const bestPrice = meta.offers[0]?.effectivePrice ?? meta.offers[0]?.price;
    const title = esc(`${meta.itemName} • Agali`);
    const description = esc(
      bestPrice
        ? `${meta.offers.length} magasins • à partir de ₪${bestPrice.toFixed(2)} • ${city || 'Agali'}`
        : `${meta.itemName} • Agali`
    );
    const safeRedirect = esc(redirectTarget);
    const safeImage = esc(imageUrl);

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=60');

    return res.send(`<!DOCTYPE html>
<html lang="${lang}" dir="${lang === 'he' ? 'rtl' : 'ltr'}">
<head>
  <meta charset="utf-8" />
  <title>${title}</title>
  <meta property="og:type" content="website" />
  <meta property="og:title" content="${title}" />
  <meta property="og:description" content="${description}" />
  <meta property="og:image" content="${safeImage}" />
  <meta property="og:image:type" content="image/png" />
  <meta property="og:image:width" content="${SHARE_IMAGE_WIDTH}" />
  <meta property="og:image:height" content="${SHARE_IMAGE_HEIGHT}" />
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
  <p>Redirecting...</p>
</body>
</html>`);
  } catch (error) {
    console.error('[GET /share/product/:barcode]', error);
    return res.redirect(redirectTarget);
  }
});

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
