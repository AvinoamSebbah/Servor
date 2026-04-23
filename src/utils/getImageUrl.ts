import crypto from 'crypto';

const IMGPROXY_BASE_URL = process.env.IMGPROXY_BASE_URL || 'https://img.agali.live';

function toUrlSafeBase64(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeHex(value: string, label: string): Buffer {
  if (!/^[0-9a-fA-F]+$/.test(value) || value.length % 2 !== 0) {
    throw new Error(`${label} must be a valid even-length hex string`);
  }

  return Buffer.from(value, 'hex');
}

export function getImageUrl(path: string, width: number, height: number): string {
  const keyHex = process.env.IMGPROXY_KEY;
  const saltHex = process.env.IMGPROXY_SALT;
  const bucket = process.env.DO_SPACES_BUCKET;

  if (!keyHex || !saltHex || !bucket) {
    throw new Error('Missing IMGPROXY_KEY, IMGPROXY_SALT, or DO_SPACES_BUCKET');
  }

  const normalizedPath = String(path || '').replace(/^\/+/, '');
  if (!normalizedPath) {
    throw new Error('Image path is required');
  }

  const transformationPath = `/rs:fill:${Math.max(1, Math.floor(width))}:${Math.max(1, Math.floor(height))}/plain/s3://${bucket}/${encodeURI(normalizedPath)}@webp`;
  const key = decodeHex(keyHex, 'IMGPROXY_KEY');
  const salt = decodeHex(saltHex, 'IMGPROXY_SALT');
  const signature = toUrlSafeBase64(
    crypto.createHmac('sha256', key).update(Buffer.concat([salt, Buffer.from(transformationPath)])).digest()
  );

  return `${IMGPROXY_BASE_URL}/${signature}${transformationPath}`;
}

export default getImageUrl;
