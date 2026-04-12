import { Router } from 'express';
import axios from 'axios';
import https from 'https';
import crypto from 'crypto';
import { v2 as cloudinary } from 'cloudinary';
import fs from 'fs';
import path from 'path';

const router = Router();

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

const PRODUCTS_FOLDER = 'products';
const STORES_FOLDER   = 'stores';
const IMAGE_NEGATIVE_CACHE_TTL_MS = 30 * 60 * 1000;

type NegativeImageCacheEntry = {
  expiresAt: number;
};

const negativeImageCache = new Map<string, NegativeImageCacheEntry>();

// Maps the Hebrew chain_name (as returned by the DB) to a URL-safe Cloudinary slug.
// File convention: stores/<slug>.jpg
const CHAIN_NAME_SLUG_MAP: Record<string, string> = {
  'BE':                                        'be',
  'Dabach':                                    'dabach',
  'Dor Alon':                                  'dor-alon',
  'אושר עד':                                   'osher-ad',
  'ג.מ. מעיין אלפיים (07) בע"מ':              'maayan-alpayim',
  'גוד מרקט':                                  'good-market',
  'גוד פארם בע"מ':                             'good-pharm',
  'וולט מרקט':                                 'wolt-market',
  'זול ובגדול בע"מ':                           'zol-vebegadol',
  'טיב טעם':                                   'tiv-taam',
  'יוניברס':                                   'universe',
  'יש':                                        'yesh',
  'יש חסד':                                    'yesh-hesed',
  'מ. יוחננוף ובניו':                          'yochananof',
  'משנת יוסף - קיי טי יבוא ושיווק בע"מ':      'mishnat-yosef',
  'נתיב החסד- סופר חסד בע"מ':                 'nativ-hahesed',
  'סופר ברקת קמעונאות בע"מ':                  'bareket',
  'סופר יודה':                                 'super-yuda',
  'סופר ספיר בע"מ':                            'super-sapir',
  'סטופמרקט':                                  'stop-market',
  'סיטי מרקט':                                 'city-market',
  'סיטי צפריר בע"מ':                           'city-tzafrir',
  'פוליצר':                                    'politzer',
  'פז קמעונאות ואנרגיה בע"מ':                  'paz',
  'פרש מרקט':                                  'fresh-market',
  'קי טי יבוא ושווק בע"מ':                     'kt-import',
  'רמי לוי בשכונה':                            'rami-levy-bashchuna',
  'רמי לוי שיווק השקמה':                       'rami-levy',
  'שופרסל':                                    'shufersal',
  'שופרסל ONLINE':                              'shufersal-online',
  'שופרסל אקספרס':                             'shufersal-express',
  'שופרסל דיל':                                'shufersal-deal',
  'שופרסל שלי':                                'shufersal-sheli',
  'שוק העיר (ט.ע.מ.ס.) בע"מ':                 'shuk-hair',
  'שפע ברכת השם בע"מ':                         'shefa-barakat',
};

// ─── Cloudinary helpers ───────────────────────────────────────────────────────

function isCloudinaryConfigured(): boolean {
  const name = process.env.CLOUDINARY_CLOUD_NAME;
  const key  = process.env.CLOUDINARY_API_KEY;
  const sec  = process.env.CLOUDINARY_API_SECRET;
  return (
    !!name && !name.startsWith('[') &&
    !!key  && !key.startsWith('[') &&
    !!sec  && !sec.startsWith('[')
  );
}

/** Check if image already cached in Cloudinary */
async function getCloudinaryUrl(publicId: string): Promise<string | null> {
  if (!isCloudinaryConfigured()) return null;
  try {
    const result = await cloudinary.api.resource(publicId);
    return result.secure_url as string;
  } catch {
    return null;
  }
}

export async function getCloudinaryProductUrl(barcode: string): Promise<string | null> {
  const publicId = `${PRODUCTS_FOLDER}/${barcode}`;
  return getCloudinaryUrl(publicId);
}

export function getCloudinaryProductDeliveryUrl(barcode: string): string | null {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  if (!cloudName || cloudName.startsWith('[')) return null;
  const encodedBarcode = encodeURIComponent(barcode);
  return `https://res.cloudinary.com/${cloudName}/image/upload/products/${encodedBarcode}.jpg`;
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function nowMs(): number {
  return Date.now();
}
function getCloudinaryConfigOrThrow() {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  if (!cloudName || !apiKey || !apiSecret) {
    throw new Error('Cloudinary credentials are missing');
  }
  return { cloudName, apiKey, apiSecret };
}

function signCloudinaryParams(params: Record<string, string | number>, apiSecret: string): string {
  const signable = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && String(value).length > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  return crypto.createHash('sha1').update(`${signable}${apiSecret}`).digest('hex');
}

async function uploadWithCloudinaryRest(publicId: string, fileValue: string): Promise<string> {
  const { cloudName, apiKey, apiSecret } = getCloudinaryConfigOrThrow();
  const timestamp = Math.floor(Date.now() / 1000);
  const paramsToSign = {
    overwrite: 'true',
    public_id: publicId,
    timestamp,
  };
  const signature = signCloudinaryParams(paramsToSign, apiSecret);

  const body = new URLSearchParams();
  body.set('file', fileValue);
  body.set('public_id', publicId);
  body.set('overwrite', 'true');
  body.set('timestamp', String(timestamp));
  body.set('api_key', apiKey);
  body.set('signature', signature);

  const url = `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`;
  const response = await axios.post(url, body.toString(), {
    httpsAgent,
    timeout: 8000,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    validateStatus: () => true,
  });

  if (response.status < 200 || response.status >= 300) {
    const apiError = response.data?.error?.message || response.statusText || 'upload failed';
    throw new Error(`Cloudinary upload failed: status=${response.status} message=${apiError}`);
  }

  const secureUrl = response.data?.secure_url;
  if (!secureUrl) {
    throw new Error('Cloudinary upload succeeded without secure_url');
  }
  return secureUrl as string;
}

/**
 * Ask Cloudinary to fetch the image from a remote URL directly.
 * Cloudinary's own servers (US-based) make the request — bypasses any geo-blocking
 * that would affect our Render (Frankfurt) server.
 */
async function uploadFromUrl(publicId: string, remoteUrl: string): Promise<string> {
  if (!isCloudinaryConfigured()) throw new Error('Cloudinary not configured');
  return uploadWithCloudinaryRest(publicId, remoteUrl);
}

/** Upload a local buffer to Cloudinary (used as fallback when we already have the bytes) */
function uploadBuffer(publicId: string, buffer: Buffer, contentType = 'image/jpeg'): Promise<string> {
  if (!isCloudinaryConfigured()) return Promise.reject(new Error('Cloudinary not configured'));
  const dataUri = `data:${contentType};base64,${buffer.toString('base64')}`;
  return uploadWithCloudinaryRest(publicId, dataUri);
}

// ─── External sources ────────────────────────────────────────────────────────

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

/** Returns the OpenFoodFacts image URL for a barcode, or null */
async function fetchOpenFoodFactsUrl(barcode: string): Promise<string | null> {
  try {
    const res = await axios.get(
      `https://world.openfoodfacts.org/api/v0/product/${barcode}.json`,
      { timeout: 1200, httpsAgent }
    );
    return res.data?.product?.image_front_url
      ?? res.data?.product?.image_url
      ?? null;
  } catch {
    return null;
  }
}

type DownloadResult = {
  ok: boolean;
  status: number;
  contentType: string;
  bytes: number;
  buffer: Buffer | null;
};

/**
 * Core per-barcode lookup — ORDER:
 *
 * 1. Cloudinary cache            → return immediately, free
 * 2. Cloudinary fetches Pricez   → Cloudinary's US servers pull from Pricez
 *                                   (bypasses geo-block on Render/EU),
 *                                   image stored permanently in Cloudinary
 * 3. Cloudinary fetches OFF      → same mechanism via OpenFoodFacts
 * 4. null
 */
async function resolveImage(
  barcode: string,
  traceId: string = 'single',
): Promise<{ imageUrl: string | null; source: string }> {
  const startMs = nowMs();
  const publicId = `${PRODUCTS_FOLDER}/${barcode}`;

  const negativeCached = negativeImageCache.get(barcode);
  if (negativeCached && negativeCached.expiresAt > Date.now()) {
    return { imageUrl: null, source: 'negative-cache' };
  }

  // 1) Try Pricez once
  const pricezUrl = `https://m.pricez.co.il/ProductPictures/200x/${barcode}.jpg`;
  try {
    const url = await uploadFromUrl(publicId, pricezUrl);
    return { imageUrl: url, source: 'pricez' };
  } catch {
    // continue to OFF
  }

  // 2) Try OpenFoodFacts once
  const offUrlValue = (await fetchOpenFoodFactsUrl(barcode)) ?? '';
  if (offUrlValue.length > 0) {
    const offUrlSafe = offUrlValue;
    try {
      const url = await uploadFromUrl(publicId, offUrlSafe);
      return { imageUrl: url, source: 'openfoodfacts' };
    } catch {
      // no-op
    }
  }

  negativeImageCache.set(barcode, { expiresAt: Date.now() + IMAGE_NEGATIVE_CACHE_TTL_MS });
  return { imageUrl: null, source: 'none' };
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// GET /api/products/image/:barcode
// Single image lookup (used by ProductDetailPage)
router.get('/image/:barcode', async (req, res) => {
  const routeStartMs = nowMs();
  const traceId = `single:${req.params.barcode}:${routeStartMs}`;
  try {
    const { barcode } = req.params;
    const result = await resolveImage(barcode, traceId);
    
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/products/images/batch
// Body: { barcodes: string[] }
// Returns: { images: Record<barcode, { imageUrl: string | null; source: string }> }
// All barcodes are resolved in parallel so the response arrives in one shot.
router.post('/images/batch', async (req, res) => {
  const routeStartMs = nowMs();
  try {
    const { barcodes } = req.body as { barcodes?: unknown };

    if (!Array.isArray(barcodes) || barcodes.length === 0) {
      return res.status(400).json({ error: 'barcodes array required' });
    }

    // Clamp to avoid abuse
    const codes = (barcodes as string[])
      .map((code) => String(code || '').trim())
      .filter((code) => code.length > 0)
      .slice(0, 50);
    const traceId = `batch:${routeStartMs}:${codes.length}`;

    const entries = await Promise.all(
      codes.map(async (barcode, index) => {
        const result = await resolveImage(barcode, `${traceId}:${index}`);
        return [barcode, result] as const;
      })
    );

    const images = Object.fromEntries(entries);
    const summary = Object.entries(images).reduce<Record<string, number>>((acc, [, value]) => {
      const key = value?.source || 'unknown';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    return res.json({ images });
  } catch (error) {
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/products/store-logo/:chainId
// Returns the logo URL for a store chain from Cloudinary folder "stores/"
router.get('/store-logo/:chainId', async (req, res) => {
  try {
    const { chainId } = req.params;
    const publicId = `${STORES_FOLDER}/${chainId}`;
    const url = await getCloudinaryUrl(publicId);
    return res.json({ imageUrl: url, chainId });
  } catch (error) {
    console.error('[STORE LOGO] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/products/store-logo/by-name/:chainName
// Looks up the logo by the chain's Hebrew name (URL-encoded).
// The name is mapped to a stable English slug used as the Cloudinary public_id.
// Example: GET /api/products/store-logo/by-name/%D7%A9%D7%95%D7%A4%D7%A8%D7%A1%D7%9C
//          → looks up stores/shufersal in Cloudinary
router.get('/store-logo/by-name/:chainName', async (req, res) => {
  try {
    const chainName = decodeURIComponent(req.params.chainName);
    const slug = CHAIN_NAME_SLUG_MAP[chainName];
    if (!slug) {
      return res.json({ imageUrl: null, chainName, slug: null });
    }

    // 1. Cloudinary (production)
    const publicId = `${STORES_FOLDER}/${slug}`;
    const cloudinaryUrl = await getCloudinaryUrl(publicId);
    if (cloudinaryUrl) {
      return res.json({ imageUrl: cloudinaryUrl, chainName, slug });
    }

    // 2. Local static fallback (development)
    const storesDir = path.join(__dirname, '../../public/images/stores');
    for (const ext of ['.jpg', '.jpeg', '.png', '.webp']) {
      if (fs.existsSync(path.join(storesDir, slug + ext))) {
        const baseUrl = `${req.protocol}://${req.get('host')}`;
        return res.json({ imageUrl: `${baseUrl}/images/stores/${slug}${ext}`, chainName, slug });
      }
    }

    return res.json({ imageUrl: null, chainName, slug });
  } catch (error) {
    console.error('[STORE LOGO BY NAME] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/products/store-slugs
// Returns the full chain-name → slug mapping (useful for clients and upload scripts).
router.get('/store-slugs', (_req, res) => {
  res.json(CHAIN_NAME_SLUG_MAP);
});

export { resolveImage };
export default router;
