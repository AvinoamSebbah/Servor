const DEFAULT_MEDIA_BASE_URL = 'https://agali-media.fra1.digitaloceanspaces.com';

function normalizeMediaPath(input: string): string {
  return String(input || '').replace(/^\/+/, '');
}

export function getMediaBaseUrl(): string {
  return (process.env.MEDIA_BASE_URL || DEFAULT_MEDIA_BASE_URL).replace(/\/+$/, '');
}

export function buildMediaUrl(path: string): string {
  const normalizedPath = normalizeMediaPath(path);
  if (!normalizedPath) {
    throw new Error('Media path is required');
  }

  return `${getMediaBaseUrl()}/${normalizedPath}`;
}

export function getProductImagePath(barcode: string): string {
  return `products/${encodeURIComponent(String(barcode || '').trim())}.jpg`;
}

export function getProductImageUrl(barcode: string): string | null {
  const normalized = String(barcode || '').trim();
  if (!normalized) return null;
  return buildMediaUrl(getProductImagePath(normalized));
}

export function getCatalogImagePath(id: string): string {
  return `catalog/${encodeURIComponent(String(id || '').trim())}.png`;
}

export function getCatalogImageUrl(id: string): string | null {
  const normalized = String(id || '').trim();
  if (!normalized) return null;
  return buildMediaUrl(getCatalogImagePath(normalized));
}

export function getStoreLogoPath(slug: string): string {
  return `stores/${encodeURIComponent(String(slug || '').trim())}.jpg`;
}

export function getStoreLogoUrl(slug: string): string | null {
  const normalized = String(slug || '').trim();
  if (!normalized) return null;
  return buildMediaUrl(getStoreLogoPath(normalized));
}
