import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient, Prisma } from '@prisma/client';
import multer from 'multer';

const router = Router();
const prisma = new PrismaClient();

const MAX_RECEIPT_IMAGES = Number(process.env.RECEIPT_SCAN_MAX_IMAGES || 5);
const MAX_RECEIPT_IMAGE_BYTES = Number(process.env.RECEIPT_SCAN_MAX_IMAGE_BYTES || 10 * 1024 * 1024);
const RECEIPT_OCR_TIMEOUT_MS = Number(process.env.RECEIPT_OCR_TIMEOUT_MS || 120_000);
const DEFAULT_RECEIPT_OCR_URL =
  process.env.NODE_ENV === 'production'
    ? 'http://agali-receipt-ocr:8000'
    : 'http://127.0.0.1:8000';
const RECEIPT_OCR_URL = (process.env.RECEIPT_OCR_URL || DEFAULT_RECEIPT_OCR_URL).replace(/\/$/, '');
const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

interface OcrBatchResponse {
  success: boolean;
  unique_codes?: string[];
  raw_candidates?: string[];
  processing_time_ms?: number;
}

interface ProductLookupRow {
  item_code: string;
  item_name: string | null;
  manufacturer_name: string | null;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_RECEIPT_IMAGE_BYTES,
    files: MAX_RECEIPT_IMAGES,
  },
  fileFilter(_req, file, callback) {
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      callback(new Error('Unsupported image type'));
      return;
    }
    callback(null, true);
  },
});

function extractToken(req: Request): string | null {
  const cookieToken = req.cookies?.['auth_token'];
  if (cookieToken && typeof cookieToken === 'string') return cookieToken.trim() || null;

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return null;
  return authHeader.slice('Bearer '.length).trim() || null;
}

async function getUserByToken(token: string) {
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT u.id
     FROM auth_tokens at
     JOIN users u ON u.id = at.user_id
     WHERE at.token = $1 AND at.expires_at > NOW()`,
    token
  );
  return rows[0] || null;
}

function getReceiptFiles(req: Request): Express.Multer.File[] {
  if (!Array.isArray(req.files)) return [];
  return req.files.filter((file) => ['images', 'image', 'files'].includes(file.fieldname));
}

function handleUploadErrors(error: unknown, res: Response): boolean {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ error: 'Receipt image is too large' });
      return true;
    }
    if (error.code === 'LIMIT_FILE_COUNT') {
      res.status(400).json({ error: `Maximum ${MAX_RECEIPT_IMAGES} images allowed` });
      return true;
    }
  }

  if (error instanceof Error && error.message === 'Unsupported image type') {
    res.status(415).json({ error: 'Unsupported image type' });
    return true;
  }

  return false;
}

function uploadReceiptImages(req: Request, res: Response, next: NextFunction) {
  upload.any()(req, res, (error) => {
    if (!error) {
      next();
      return;
    }
    if (!handleUploadErrors(error, res)) {
      next(error);
    }
  });
}

async function forwardToReceiptOcr(files: Express.Multer.File[]): Promise<OcrBatchResponse> {
  const formData = new FormData();
  files.forEach((file, index) => {
    const filename = file.originalname || `receipt-${index + 1}.jpg`;
    const bytes = new Uint8Array(file.buffer.byteLength);
    bytes.set(file.buffer);
    formData.append('files', new Blob([bytes.buffer], { type: file.mimetype }), filename);
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RECEIPT_OCR_TIMEOUT_MS);

  try {
    const response = await fetch(`${RECEIPT_OCR_URL}/api/v1/receipts/extract-barcodes-batch`, {
      method: 'POST',
      body: formData,
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text();
      console.error('Receipt OCR service error:', response.status, body);
      throw new Error('Receipt OCR service returned an error');
    }

    return await response.json() as OcrBatchResponse;
  } finally {
    clearTimeout(timeout);
  }
}

async function analyzeReceipt(req: Request, res: Response) {
  try {
    const token = extractToken(req);
    if (!token) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const user = await getUserByToken(token);
    if (!user) {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }

    const files = getReceiptFiles(req);
    if (files.length === 0) {
      return res.status(400).json({ error: 'No receipt image provided' });
    }
    if (files.length > MAX_RECEIPT_IMAGES) {
      return res.status(400).json({ error: `Maximum ${MAX_RECEIPT_IMAGES} images allowed` });
    }

    const ocrResult = await forwardToReceiptOcr(files);
    const uniqueBarcodes = [...new Set(ocrResult.unique_codes || [])];

    if (uniqueBarcodes.length === 0) {
      return res.json({
        barcodes: [],
        products: [],
        scan: {
          imageCount: files.length,
          rawCandidateCount: ocrResult.raw_candidates?.length || 0,
          processingTimeMs: ocrResult.processing_time_ms || 0,
        },
      });
    }

    const products = await prisma.$queryRaw<ProductLookupRow[]>(Prisma.sql`
      SELECT
        p.item_code,
        p.item_name,
        p.manufacturer_name
      FROM products p
      WHERE p.item_code = ANY(${uniqueBarcodes}::text[])
    `);

    const productMap = new Map(products.map((product) => [product.item_code, product]));
    const results = uniqueBarcodes.map((barcode) => {
      const product = productMap.get(barcode);
      return {
        barcode,
        found: Boolean(product),
        product: product
          ? {
              itemCode: product.item_code,
              itemName: product.item_name,
              manufacturerName: product.manufacturer_name,
              price: null,
              storeName: null,
            }
          : null,
      };
    });

    return res.json({
      barcodes: uniqueBarcodes,
      products: results,
      scan: {
        imageCount: files.length,
        rawCandidateCount: ocrResult.raw_candidates?.length || 0,
        processingTimeMs: ocrResult.processing_time_ms || 0,
      },
    });
  } catch (error) {
    if (handleUploadErrors(error, res)) {
      return;
    }

    if (error instanceof Error && error.name === 'AbortError') {
      console.error('Receipt OCR timeout');
      return res.status(504).json({ error: 'Receipt analysis timed out' });
    }

    const networkCode =
      error instanceof Error && 'cause' in error && error.cause && typeof error.cause === 'object'
        ? (error.cause as { code?: string }).code
        : undefined;
    if (networkCode === 'ENOTFOUND' || networkCode === 'ECONNREFUSED') {
      console.error(`Receipt OCR service unavailable at ${RECEIPT_OCR_URL}:`, error);
      return res.status(503).json({ error: 'Receipt OCR service is unavailable' });
    }

    console.error('Error analyzing receipt:', error);
    return res.status(502).json({ error: 'Failed to analyze receipt' });
  }
}

router.post('/receipt', uploadReceiptImages, analyzeReceipt);
// Keep the original path working for older clients while switching the implementation to local OCR.
router.post('/analyze', uploadReceiptImages, analyzeReceipt);

export default router;
