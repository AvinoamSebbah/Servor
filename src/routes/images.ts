import { Router } from 'express';
import axios from 'axios';
import { v2 as cloudinary } from 'cloudinary';
import fs from 'fs';
import https from 'https';
import path from 'path';
import { PassThrough } from 'stream';
import { pipeline } from 'stream/promises';
import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import getImageUrl from '../utils/getImageUrl';
import { getCatalogImagePath, getProductImagePath, getStoreLogoUrl } from '../utils/media';

const router = Router();

const IMAGE_NEGATIVE_CACHE_TTL_MS = 30 * 60 * 1000;

type NegativeImageCacheEntry = {
  expiresAt: number;
};

const negativeImageCache = new Map<string, NegativeImageCacheEntry>();
const skipTlsVerify = String(process.env.DO_SPACES_SKIP_TLS_VERIFY || '').trim().toLowerCase() === 'true';
const externalHttpsAgent = new https.Agent({
  rejectUnauthorized: !skipTlsVerify,
});

if (
  process.env.CLOUDINARY_CLOUD_NAME &&
  process.env.CLOUDINARY_API_KEY &&
  process.env.CLOUDINARY_API_SECRET
) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
  });
}

const CHAIN_NAME_SLUG_MAP: Record<string, string> = {
  'BE': 'be',
  'Dabach': 'dabach',
  'Dor Alon': 'dor-alon',
  'אושר עד': 'osher-ad',
  'ג.מ. מעיין אלפיים (07) בע"מ': 'maayan-alpayim',
  'גוד מרקט': 'good-market',
  'גוד פארם בע"מ': 'good-pharm',
  'וולט מרקט': 'wolt-market',
  'זול ובגדול בע"מ': 'zol-vebegadol',
  'טיב טעם': 'tiv-taam',
  'יוניברס': 'universe',
  'יש': 'yesh',
  'יש חסד': 'yesh-hesed',
  'מ. יוחננוף ובניו': 'yochananof',
  'משנת יוסף - קיי טי יבוא ושיווק בע"מ': 'mishnat-yosef',
  'נתיב החסד- סופר חסד בע"מ': 'nativ-hahesed',
  'סופר ברקת קמעונאות בע"מ': 'bareket',
  'סופר יודה': 'super-yuda',
  'סופר ספיר בע"מ': 'super-sapir',
  'סטופמרקט': 'stop-market',
  'סיטי מרקט': 'city-market',
  'סיטי צפריר בע"מ': 'city-tzafrir',
  'פוליצר': 'politzer',
  'פז קמעונאות ואנרגיה בע"מ': 'paz',
  'פרש מרקט': 'fresh-market',
  'קי טי יבוא ושווק בע"מ': 'kt-import',
  'רמי לוי בשכונה': 'rami-levy-bashchuna',
  'רמי לוי שיווק השקמה': 'rami-levy',
  'שופרסל': 'shufersal',
  'שופרסל ONLINE': 'shufersal-online',
  'שופרסל אקספרס': 'shufersal-express',
  'שופרסל דיל': 'shufersal-deal',
  'שופרסל שלי': 'shufersal-sheli',
  'שוק העיר (ט.ע.מ.ס.) בע"מ': 'shuk-hair',
  'שפע ברכת השם בע"מ': 'shefa-barakat',
};

function createS3Client(): S3Client {
  const region = process.env.DO_SPACES_REGION;
  const accessKeyId = process.env.DO_SPACES_ACCESS_KEY;
  const secretAccessKey = process.env.DO_SPACES_SECRET_KEY;

  if (!region || !accessKeyId || !secretAccessKey) {
    throw new Error('DigitalOcean Spaces credentials are missing');
  }

  return new S3Client({
    region,
    endpoint: `https://${region}.digitaloceanspaces.com`,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
    requestHandler: new NodeHttpHandler({
      httpsAgent: new https.Agent({
        rejectUnauthorized: !skipTlsVerify,
      }),
    }),
  });
}

const s3 = createS3Client();

function getBucketOrThrow(): string {
  const bucket = process.env.DO_SPACES_BUCKET;
  if (!bucket) {
    throw new Error('DO_SPACES_BUCKET is missing');
  }
  return bucket;
}

function nowMs(): number {
  return Date.now();
}

function isCloudinaryBridgeEnabled(): boolean {
  return Boolean(
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET,
  );
}

async function fetchViaCloudinaryBridge(remoteUrl: string, publicId: string): Promise<string> {
  if (!isCloudinaryBridgeEnabled()) {
    throw new Error('Cloudinary bridge is not configured');
  }

  const result = await cloudinary.uploader.upload(remoteUrl, {
    public_id: publicId,
    folder: 'spaces-bridge',
    overwrite: true,
    invalidate: false,
    resource_type: 'image',
  });

  if (!result.secure_url) {
    throw new Error('Cloudinary bridge upload did not return secure_url');
  }

  return result.secure_url;
}

async function objectExists(key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({
      Bucket: getBucketOrThrow(),
      Key: key,
    }));
    return true;
  } catch (error) {
    const statusCode = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
    const name = (error as { name?: string })?.name;
    if (statusCode === 404 || name === 'NotFound' || name === 'NoSuchKey') {
      return false;
    }
    throw error;
  }
}

async function uploadRemoteImageToSpaces(key: string, remoteUrl: string, source: string): Promise<string> {
  const response = await axios({
    method: 'get',
    url: remoteUrl,
    responseType: 'stream',
    httpsAgent: externalHttpsAgent,
    timeout: 15000,
    maxRedirects: 5,
    validateStatus: (status) => status >= 200 && status < 300,
  });

  const contentType = response.headers['content-type'] || 'image/jpeg';
  const body = new PassThrough();
  const upload = new Upload({
    client: s3,
    params: {
      Bucket: getBucketOrThrow(),
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: 'public, max-age=31536000, immutable',
      Metadata: {
        fetched_from: source,
      },
    },
  });

  const uploadPromise = upload.done();
  await pipeline(response.data, body);
  await uploadPromise;

  return getSignedProductDeliveryUrl(path.basename(key, path.extname(key))) as string;
}

function getSignedProductDeliveryUrl(barcode: string, width = 320, height = 320): string | null {
  const normalizedBarcode = String(barcode || '').trim();
  if (!normalizedBarcode) return null;
  return getImageUrl(getProductImagePath(normalizedBarcode), width, height);
}

function getSignedCatalogDeliveryUrl(id: string, width = 320, height = 320): string | null {
  const normalizedId = String(id || '').trim();
  if (
    !normalizedId ||
    normalizedId.startsWith('custom_') ||
    normalizedId.startsWith('custom_preview_') ||
    normalizedId === 'cat_other' ||
    normalizedId === 'sub_other'
  ) {
    return null;
  }

  return getImageUrl(getCatalogImagePath(normalizedId), width, height);
}

async function fetchOpenFoodFactsUrl(barcode: string): Promise<string | null> {
  try {
    const res = await axios.get(
      `https://world.openfoodfacts.org/api/v0/product/${encodeURIComponent(barcode)}.json`,
      {
        timeout: 3000,
        httpsAgent: externalHttpsAgent,
      },
    );
    return res.data?.product?.image_front_url
      ?? res.data?.product?.image_url
      ?? null;
  } catch {
    return null;
  }
}

async function findAndPersistMissingImage(barcode: string, key: string): Promise<{ imageUrl: string | null; source: string }> {
  const pricezUrl = `https://m.pricez.co.il/ProductPictures/200x/${encodeURIComponent(barcode)}.jpg`;
  try {
    await uploadRemoteImageToSpaces(key, pricezUrl, 'pricez');
    return { imageUrl: getSignedProductDeliveryUrl(barcode), source: 'pricez' };
  } catch (error) {
    if (isCloudinaryBridgeEnabled()) {
      try {
        const bridgedUrl = await fetchViaCloudinaryBridge(pricezUrl, `pricez-${barcode}`);
        await uploadRemoteImageToSpaces(key, bridgedUrl, 'pricez-cloudinary-bridge');
        return { imageUrl: getSignedProductDeliveryUrl(barcode), source: 'pricez-cloudinary-bridge' };
      } catch (bridgeError) {
        console.warn(`[PRODUCT IMAGE] Pricez bridge failed for ${barcode}`, {
          directError: error instanceof Error ? error.message : String(error),
          bridgeError: bridgeError instanceof Error ? bridgeError.message : String(bridgeError),
        });
      }
    }
  }

  const openFoodFactsUrl = await fetchOpenFoodFactsUrl(barcode);
  if (openFoodFactsUrl) {
    try {
      await uploadRemoteImageToSpaces(key, openFoodFactsUrl, 'openfoodfacts');
      return { imageUrl: getSignedProductDeliveryUrl(barcode), source: 'openfoodfacts' };
    } catch {
      // continue to none
    }
  }

  negativeImageCache.set(barcode, { expiresAt: nowMs() + IMAGE_NEGATIVE_CACHE_TTL_MS });
  return { imageUrl: null, source: 'none' };
}

export async function resolveImage(
  barcode: string,
  _traceId = 'single',
  options?: {
    bypassNegativeCache?: boolean;
  },
): Promise<{ imageUrl: string | null; source: string }> {
  const normalizedBarcode = String(barcode || '').trim();
  if (!normalizedBarcode) {
    return { imageUrl: null, source: 'none' };
  }

  const negativeCached = negativeImageCache.get(normalizedBarcode);
  if (!options?.bypassNegativeCache && negativeCached && negativeCached.expiresAt > nowMs()) {
    return { imageUrl: null, source: 'negative-cache' };
  }

  const key = getProductImagePath(normalizedBarcode);
  if (await objectExists(key)) {
    return {
      imageUrl: getSignedProductDeliveryUrl(normalizedBarcode),
      source: 'spaces',
    };
  }

  return findAndPersistMissingImage(normalizedBarcode, key);
}

export function getProductDeliveryUrl(barcode: string): string | null {
  return getSignedProductDeliveryUrl(barcode);
}

function resolveLocalStoreLogo(reqHost: string, protocol: string, slug: string): string | null {
  const storesDir = path.join(__dirname, '../../public/images/stores');
  for (const ext of ['.jpg', '.jpeg', '.png', '.webp']) {
    if (fs.existsSync(path.join(storesDir, slug + ext))) {
      return `${protocol}://${reqHost}/images/stores/${slug}${ext}`;
    }
  }
  return null;
}

router.get('/image/:barcode', async (req, res) => {
  try {
    const { barcode } = req.params;
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    return res.json(await resolveImage(barcode, 'single', { bypassNegativeCache: true }));
  } catch (error) {
    console.error('[PRODUCT IMAGE] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/catalog-image/:id', (req, res) => {
  const imageUrl = getSignedCatalogDeliveryUrl(req.params.id);
  if (!imageUrl) {
    return res.status(404).json({ error: 'Catalog image not found' });
  }

  res.setHeader('Cache-Control', 'public, max-age=300');
  return res.redirect(302, imageUrl);
});

router.post('/catalog-images/batch', (req, res) => {
  const body = req.body as { ids?: unknown; products?: unknown };
  const idsFromProducts = Array.isArray(body?.products)
    ? (body.products as Array<{ id?: unknown }>).map((product) => String(product?.id || '').trim())
    : [];
  const ids = Array.isArray(body?.ids)
    ? (body.ids as unknown[]).map((id) => String(id || '').trim())
    : idsFromProducts;

  const images = Object.fromEntries(
    ids
      .filter((id) => id.length > 0)
      .slice(0, 500)
      .map((id) => {
        const imageUrl = getSignedCatalogDeliveryUrl(id);
        return [
          id,
          {
            imageUrl,
            pending: false,
            source: imageUrl ? 'catalog' : 'none',
          },
        ];
      }),
  );

  res.setHeader('Cache-Control', 'public, max-age=300');
  return res.json({ images });
});

router.post('/images/batch', async (req, res) => {
  try {
    const { barcodes } = req.body as { barcodes?: unknown };

    if (!Array.isArray(barcodes) || barcodes.length === 0) {
      return res.status(400).json({ error: 'barcodes array required' });
    }

    const codes = (barcodes as string[])
      .map((code) => String(code || '').trim())
      .filter((code) => code.length > 0)
      .slice(0, 50);

    const entries = await Promise.all(
      codes.map(async (barcode) => [barcode, await resolveImage(barcode)] as const),
    );

    return res.json({ images: Object.fromEntries(entries) });
  } catch (error) {
    console.error('[PRODUCT IMAGE BATCH] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/store-logo/:chainId', async (req, res) => {
  try {
    const { chainId } = req.params;
    const imageUrl = getStoreLogoUrl(chainId);
    return res.json({ imageUrl, chainId });
  } catch (error) {
    console.error('[STORE LOGO] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/store-logo/by-name/:chainName', async (req, res) => {
  try {
    const chainName = decodeURIComponent(req.params.chainName);
    const slug = CHAIN_NAME_SLUG_MAP[chainName];
    if (!slug) {
      return res.json({ imageUrl: null, chainName, slug: null });
    }

    const imageUrl =
      getStoreLogoUrl(slug) ||
      resolveLocalStoreLogo(req.get('host') || '', req.protocol, slug);

    return res.json({ imageUrl, chainName, slug });
  } catch (error) {
    console.error('[STORE LOGO BY NAME] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/store-slugs', (_req, res) => {
  res.json(CHAIN_NAME_SLUG_MAP);
});

export default router;
