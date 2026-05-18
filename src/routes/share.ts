import { Router, Request, Response } from 'express';
import { randomBytes } from 'crypto';
import { PrismaClient } from '@prisma/client';
import {
  generatePromoShareImage,
  generatePromotionsShareImage,
  generateProductShareImage,
  generateShoppingListShareImage,
  generateSiteShareImage,
  getPromoShareMeta,
  getPromotionsShareMeta,
  getProductShareMeta,
  parseShareLang,
  parseShareTheme,
  SHARE_IMAGE_HEIGHT,
  SHARE_IMAGE_WIDTH,
} from '../utils/shareImage';

const router = Router();
const prisma = new PrismaClient();

// Escape HTML entities to prevent injection in the OG HTML page
function esc(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

function getBackendBaseUrl(req: Request): string {
  // Prefer explicit env var to avoid Host header injection
  if (process.env.BACKEND_BASE_URL) return process.env.BACKEND_BASE_URL;
  const protocol = req.headers['x-forwarded-proto']?.toString().split(',')[0] || req.protocol;
  const host = req.headers['x-forwarded-host']?.toString().split(',')[0] || req.get('host') || 'localhost:3001';
  return `${protocol}://${host}`;
}

function shortString(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

function parseShortTheme(raw: unknown): 'dark' | 'light' {
  const value = shortString(raw).toLowerCase();
  if (value === 'l') return 'light';
  if (value === 'd') return 'dark';
  return parseShareTheme(raw);
}

function parseShortLang(raw: unknown) {
  return parseShareLang(raw);
}

function buildProductImageParams(city: string, theme: string, lang: string): URLSearchParams {
  const params = new URLSearchParams();
  if (city) params.set('city', city);
  params.set('theme', theme);
  params.set('lang', lang);
  return params;
}

function buildFrontendStateParams(input: {
  city?: string;
  theme: string;
  lang: string;
}): URLSearchParams {
  const params = new URLSearchParams();
  if (input.city) params.set('city', input.city);
  params.set('theme', input.theme);
  params.set('lang', input.lang);
  return params;
}

function buildPromoImageParams(input: {
  city: string;
  chainId: string;
  storeId: string;
  promotionId: string;
  theme: string;
  lang: string;
}): URLSearchParams {
  const params = new URLSearchParams();
  if (input.chainId) params.set('chainId', input.chainId);
  if (input.storeId) params.set('storeId', input.storeId);
  if (input.promotionId) params.set('promotionId', input.promotionId);
  if (input.city) params.set('city', input.city);
  params.set('theme', input.theme);
  params.set('lang', input.lang);
  return params;
}

async function sendProductSharePage(req: Request, res: Response, barcode: string) {
  const city = shortString(req.query.city) || shortString(req.query.c);
  const theme = parseShortTheme(req.query.theme ?? req.query.t);
  const lang = parseShortLang(req.query.lang ?? req.query.l);
  const FRONTEND_URL = process.env.FRONTEND_URL || 'https://agali.live';
  const redirectParams = buildFrontendStateParams({ city, theme, lang });
  const redirectTarget = `${FRONTEND_URL}/product/${encodeURIComponent(barcode)}?${redirectParams.toString()}`;

  try {
    const meta = await getProductShareMeta(prisma, barcode, city);
    const backendBaseUrl = getBackendBaseUrl(req);
    const imageUrl = `${backendBaseUrl}/share/product/${encodeURIComponent(barcode)}/image?${buildProductImageParams(city, theme, lang).toString()}`;

    const bestPrice = meta.offers[0]?.effectivePrice ?? meta.offers[0]?.price;
    const title = esc(`${meta.itemName} • Agali`);
    const description = esc(
      bestPrice
        ? `${meta.offers.length} magasins • à partir de ₪${bestPrice.toFixed(2)} • ${city || 'Agali'}`
        : `${meta.itemName} • Agali`
    );
    const safeRedirect = esc(redirectTarget);
    const safeImage = esc(imageUrl);

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
  <script nonce="${nonce}">window.location.replace(${JSON.stringify(redirectTarget)});</script>
  <p>Redirecting...</p>
</body>
</html>`);
  } catch (error) {
    console.error('[GET /share/product]', error);
    return res.redirect(redirectTarget);
  }
}

async function sendPromoSharePage(req: Request, res: Response, itemCode: string) {
  const theme = parseShortTheme(req.query.theme ?? req.query.t);
  const lang = parseShortLang(req.query.lang ?? req.query.l);
  const chainId = shortString(req.query.chainId) || shortString(req.query.ch);
  const chainName = shortString(req.query.chainName) || shortString(req.query.cn);
  const storeId = shortString(req.query.storeId) || shortString(req.query.s);
  const promotionId = shortString(req.query.promotionId) || shortString(req.query.pr);
  const city = shortString(req.query.city) || shortString(req.query.c);
  const FRONTEND_URL = process.env.FRONTEND_URL || 'https://agali.live';

  const frontendParams = buildFrontendStateParams({ city, theme, lang });
  const redirectTarget = `${FRONTEND_URL}/product/${encodeURIComponent(itemCode)}?${frontendParams.toString()}`;

  try {
    const meta = chainId ? await getPromoShareMeta(prisma, { itemCode, chainId, storeId, promotionId, city }) : null;
    const backendBaseUrl = getBackendBaseUrl(req);
    const imageUrl = `${backendBaseUrl}/share/promo/${encodeURIComponent(itemCode)}/image?${buildPromoImageParams({ city, chainId, storeId, promotionId, theme, lang }).toString()}`;
    const title = esc(`${meta?.itemName || itemCode} • Agali`);
    const description = esc(meta?.effectivePrice ? `${meta.chainName} • ₪${meta.effectivePrice.toFixed(2)}${city ? ` • ${city}` : ''}` : 'Promotion sur Agali');
    const safeRedirect = esc(redirectTarget);
    const safeImage = esc(imageUrl);

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
  <script nonce="${nonce}">window.location.replace(${JSON.stringify(redirectTarget)});</script>
  <p>Redirecting...</p>
</body>
</html>`);
  } catch (error) {
    console.error('[GET /share/promo]', error);
    return res.redirect(redirectTarget);
  }
}

router.get('/product/:barcode/image', async (req: Request, res: Response) => {
  const barcode = String(req.params.barcode);
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

router.get('/p/:barcode', async (req: Request, res: Response) => {
  return sendProductSharePage(req, res, String(req.params.barcode));
});

router.get('/product/:barcode', async (req: Request, res: Response) => {
  return sendProductSharePage(req, res, String(req.params.barcode));
});

router.get('/site/image', async (req: Request, res: Response) => {
  const theme = parseShareTheme(req.query.theme);
  const lang = parseShareLang(req.query.lang);

  try {
    const png = await generateSiteShareImage(theme, lang);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.send(png);
  } catch (error) {
    console.error('[GET /share/site/image]', error);
    return res.status(500).json({ error: 'Failed to generate site share image' });
  }
});

router.get('/site', async (req: Request, res: Response) => {
  const theme = parseShareTheme(req.query.theme);
  const lang = parseShareLang(req.query.lang);
  const FRONTEND_URL = process.env.FRONTEND_URL || 'https://agali.live';
  const backendBaseUrl = getBackendBaseUrl(req);
  const imageUrl = `${backendBaseUrl}/share/site/image?theme=${encodeURIComponent(theme)}&lang=${encodeURIComponent(lang)}`;
  const title = esc('Agali • Comparateur de prix et promotions');
  const description = esc('Compare les prix, trouve les meilleures promotions et partage tes listes de courses.');
  const frontendParams = buildFrontendStateParams({ theme, lang });
  const rawRedirect = `${FRONTEND_URL}?${frontendParams.toString()}`;
  const safeRedirect = esc(rawRedirect);
  const safeImage = esc(imageUrl);

  const nonce = randomBytes(16).toString('base64');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; frame-ancestors 'none'`);
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
  <script nonce="${nonce}">window.location.replace(${JSON.stringify(rawRedirect)});</script>
  <p>Redirecting...</p>
</body>
</html>`);
});

router.get('/promo/:itemCode/image', async (req: Request, res: Response) => {
  const itemCode = String(req.params.itemCode);
  const theme = parseShareTheme(req.query.theme);
  const lang = parseShareLang(req.query.lang);
  const chainId = typeof req.query.chainId === 'string' ? req.query.chainId.trim() : '';
  const storeId = typeof req.query.storeId === 'string' ? req.query.storeId.trim() : '';
  const promotionId = typeof req.query.promotionId === 'string' ? req.query.promotionId.trim() : '';
  const city = typeof req.query.city === 'string' ? req.query.city.trim() : '';

  if (!chainId) return res.status(400).json({ error: 'chainId is required' });

  try {
    const png = await generatePromoShareImage(prisma, { itemCode, chainId, storeId, promotionId, city }, theme, lang);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=1800');
    return res.send(png);
  } catch (error) {
    console.error('[GET /share/promo/:itemCode/image]', error);
    return res.status(500).json({ error: 'Failed to generate promo share image' });
  }
});

router.get('/d/:itemCode', async (req: Request, res: Response) => {
  return sendPromoSharePage(req, res, String(req.params.itemCode));
});

router.get('/promo/:itemCode', async (req: Request, res: Response) => {
  return sendPromoSharePage(req, res, String(req.params.itemCode));
});

router.get('/promotions/image', async (req: Request, res: Response) => {
  const theme = parseShareTheme(req.query.theme);
  const lang = parseShareLang(req.query.lang);
  const city = typeof req.query.city === 'string' ? req.query.city.trim() : '';
  const chainId = typeof req.query.chainId === 'string' ? req.query.chainId.trim() : '';
  const chainName = typeof req.query.chainName === 'string' ? req.query.chainName.trim() : '';
  const storeId = typeof req.query.storeId === 'string' ? req.query.storeId.trim() : '';

  if (!city) return res.status(400).json({ error: 'city is required' });

  try {
    const png = await generatePromotionsShareImage(prisma, { city, chainId, chainName, storeId }, theme, lang);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=1800');
    return res.send(png);
  } catch (error) {
    console.error('[GET /share/promotions/image]', error);
    return res.status(500).json({ error: 'Failed to generate promotions share image' });
  }
});

router.get('/promotions', async (req: Request, res: Response) => {
  const theme = parseShareTheme(req.query.theme);
  const lang = parseShareLang(req.query.lang);
  const city = typeof req.query.city === 'string' ? req.query.city.trim() : '';
  const chainId = typeof req.query.chainId === 'string' ? req.query.chainId.trim() : '';
  const chainName = typeof req.query.chainName === 'string' ? req.query.chainName.trim() : '';
  const storeId = typeof req.query.storeId === 'string' ? req.query.storeId.trim() : '';
  const FRONTEND_URL = process.env.FRONTEND_URL || 'https://agali.live';

  const frontendParams = new URLSearchParams();
  if (city) frontendParams.set('city', city);
  if (chainId) frontendParams.set('chainId', chainId);
  if (chainName) frontendParams.set('chainName', chainName);
  if (storeId) frontendParams.set('storeId', storeId);
  frontendParams.set('theme', theme);
  frontendParams.set('lang', lang);
  const redirectTarget = `${FRONTEND_URL}/promotions${frontendParams.toString() ? `?${frontendParams.toString()}` : ''}`;

  try {
    const meta = city ? await getPromotionsShareMeta(prisma, { city, chainId, chainName, storeId }) : null;
    const backendBaseUrl = getBackendBaseUrl(req);
    const imageParams = new URLSearchParams();
    if (city) imageParams.set('city', city);
    if (chainId) imageParams.set('chainId', chainId);
    if (chainName) imageParams.set('chainName', chainName);
    if (storeId) imageParams.set('storeId', storeId);
    imageParams.set('theme', theme);
    imageParams.set('lang', lang);
    const imageUrl = city
      ? `${backendBaseUrl}/share/promotions/image?${imageParams.toString()}`
      : `${backendBaseUrl}/share/site/image?theme=${encodeURIComponent(theme)}&lang=${encodeURIComponent(lang)}`;
    const title = esc(`${meta?.title || 'Promotions'} • Agali`);
    const description = esc(city ? `Les meilleures promotions Agali${meta?.title ? ` • ${meta.title}` : ''}` : 'Les meilleures promotions sur Agali');
    const safeRedirect = esc(redirectTarget);
    const safeImage = esc(imageUrl);

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
  <script nonce="${nonce}">window.location.replace(${JSON.stringify(redirectTarget)});</script>
  <p>Redirecting...</p>
</body>
</html>`);
  } catch (error) {
    console.error('[GET /share/promotions]', error);
    return res.redirect(redirectTarget);
  }
});

router.get('/:code/image', async (req: Request, res: Response) => {
  const code = String(req.params.code);
  const theme = parseShareTheme(req.query.theme);
  const lang = parseShareLang(req.query.lang);

  try {
    const rows = await prisma.$queryRawUnsafe<{ name: string; items: unknown }[]>(
      `SELECT name, items FROM shopping_lists WHERE code = $1 LIMIT 1`,
      code.toUpperCase()
    );

    if (rows.length === 0) {
      return res.redirect(302, `${getBackendBaseUrl(req)}/share/site/image?theme=${encodeURIComponent(theme)}&lang=${encodeURIComponent(lang)}`);
    }

    const { name, items } = rows[0];
    const rawItems = typeof items === 'string' ? JSON.parse(items) : items;
    const png = await generateShoppingListShareImage(name, rawItems, theme, lang);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=60');
    return res.send(png);
  } catch (error) {
    console.error('[GET /share/:code/image]', error);
    return res.status(500).json({ error: 'Failed to generate shopping list share image' });
  }
});

// GET /share/:code — returns an HTML page with OG meta tags then redirects to the frontend
router.get('/:code', async (req: Request, res: Response) => {
  const code = String(req.params.code);
  const theme = parseShareTheme(req.query.theme);
  const lang = parseShareLang(req.query.lang);
  const city = typeof req.query.city === 'string' ? req.query.city.trim() : '';
  const FRONTEND_URL = process.env.FRONTEND_URL || 'https://agali.live';
  const redirectParams = buildFrontendStateParams({ city, theme, lang });
  const redirectTarget = `${FRONTEND_URL}/shopping-list/run/${code.toUpperCase()}?${redirectParams.toString()}`;

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
    const backendBaseUrl = getBackendBaseUrl(req);
    const ogImage = `${backendBaseUrl}/share/${encodeURIComponent(code.toUpperCase())}/image?theme=${encodeURIComponent(theme)}&lang=${encodeURIComponent(lang)}`;
    const title = esc(`🛒 ${name}`);
    const description = esc(
      count > 0
        ? `${count} מוצרים | לחצו להצטרף לרשימה ב-Agali`
        : 'רשימת קניות שיתופית ב-Agali'
    );
    const safeRedirect = esc(redirectTarget);
    const safeImage = esc(ogImage);

    const nonce = randomBytes(16).toString('base64');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    // Cache for 60s so WhatsApp scraper gets fresh data
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; frame-ancestors 'none'`);

    return res.send(`<!DOCTYPE html>
<html lang="he" dir="rtl">
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
  <script nonce="${nonce}">window.location.replace(${JSON.stringify(redirectTarget)});</script>
  <p>מעביר אותך לרשימה...</p>
</body>
</html>`);
  } catch (err) {
    console.error('[GET /share/:code]', err);
    return res.redirect(redirectTarget);
  }
});

export default router;
