import fs from 'fs/promises';
import https from 'https';
import path from 'path';
import { Prisma, PrismaClient } from '@prisma/client';
import { Resvg } from '@resvg/resvg-js';
import axios from 'axios';
import sharp from 'sharp';
import { getCatalogImageUrl, getProductImageUrl } from './media';

type ShareTheme = 'dark' | 'light';
type ShareLang = 'he' | 'fr' | 'en';

type ProductRow = {
  item_name: string | null;
  manufacturer_name: string | null;
};

type OfferRow = {
  chain_id: string | null;
  chain_name: string | null;
  store_id: string | null;
  store_name: string | null;
  price: number | null;
  promo_price: number | null;
  effective_price: number | null;
};

type ShareOffer = {
  chainId: string | null;
  chainName: string;
  storeName: string;
  price: number | null;
  promoPrice: number | null;
  effectivePrice: number | null;
  logoDataUri: string | null;
};

const CANVAS_WIDTH = 1200;
const CANVAS_HEIGHT = 630;
export const SHARE_IMAGE_WIDTH = 1200;
export const SHARE_IMAGE_HEIGHT = 630;

const CHAIN_SLUG_MAP: Record<string, string> = {
  BE: 'be',
  Dabach: 'dabach',
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

const CHAIN_ALIASES: Record<string, string> = {
  'שופרסל אונליין': 'שופרסל ONLINE',
  'שופרסל online': 'שופרסל ONLINE',
  'שופרסל אקסטרה': 'שופרסל דיל',
  'רמי לוי': 'רמי לוי שיווק השקמה',
  'יוחננוף': 'מ. יוחננוף ובניו',
  'פרשמרקט': 'פרש מרקט',
  'וולט': 'וולט מרקט',
  'פז': 'פז קמעונאות ואנרגיה בע"מ',
};

const CHAIN_ID_SLUG_MAP: Record<string, string> = {
  '5144744100002': 'mishnat-yosef',
  '7290000000003': 'city-market',
  '7290027600007': 'shufersal-sheli',
  '7290058134977': 'shefa-barakat',
  '7290058140886': 'rami-levy',
  '7290058148776': 'shuk-hair',
  '7290058156016': 'super-sapir',
  '7290058159628': 'maayan-alpayim',
  '7290058160839': 'nativ-hahesed',
  '7290058173198': 'zol-vebegadol',
  '7290058177776': 'super-yuda',
  '7290058197699': 'good-pharm',
  '7290058249350': 'wolt-market',
  '7290058266241': 'city-tzafrir',
  '7290058289400': 'kt-import',
  '7290103152017': 'osher-ad',
  '7290492000005': 'dor-alon',
  '7290526500006': 'dabach',
  '7290639000004': 'stop-market',
  '7290644700005': 'paz',
  '7290803800003': 'yochananof',
  '7290873255550': 'tiv-taam',
  '7290875100001': 'bareket',
  '7290876100000': 'fresh-market',
  '7291056200008': 'rami-levy-bashchuna',
  '7291059100008': 'politzer',
};

const FILE_CACHE = new Map<string, string | null>();
const REMOTE_TEXT_CACHE = new Map<string, string | null>();
const PUBLIC_FRONTEND_BASE_URL = 'https://agali.live';
const LOCAL_PUBLIC_DIR = path.resolve(process.cwd(), 'public');
const LOCAL_AGALI_LOGO_PATH = path.join(LOCAL_PUBLIC_DIR, 'logo.png');

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function normalizeChainName(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/["'`]/g, '')
    .replace(/[()\[\].,:;\-_/\\]+/g, ' ')
    .replace(/\bבע\s*מ\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const NORMALIZED_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(CHAIN_SLUG_MAP).map(([name, slug]) => [normalizeChainName(name), slug])
);

const NORMALIZED_ALIASES: Record<string, string> = Object.fromEntries(
  Object.entries(CHAIN_ALIASES).map(([alias, canonical]) => [normalizeChainName(alias), canonical])
);

function inferSlugByKeyword(name: string): string | null {
  if (name.includes('שופרסל')) {
    if (name.includes('אקספרס')) return CHAIN_SLUG_MAP['שופרסל אקספרס'];
    if (name.includes('דיל') || name.includes('אקסטרה')) return CHAIN_SLUG_MAP['שופרסל דיל'];
    if (name.includes('שלי')) return CHAIN_SLUG_MAP['שופרסל שלי'];
    if (name.includes('online') || name.includes('אונליין')) return CHAIN_SLUG_MAP['שופרסל ONLINE'];
    return CHAIN_SLUG_MAP['שופרסל'];
  }
  if (name.includes('רמי לוי')) {
    if (name.includes('בשכונה')) return CHAIN_SLUG_MAP['רמי לוי בשכונה'];
    return CHAIN_SLUG_MAP['רמי לוי שיווק השקמה'];
  }
  if (name.includes('יש חסד')) return CHAIN_SLUG_MAP['יש חסד'];
  if (name.includes('יש')) return CHAIN_SLUG_MAP['יש'];
  if (name.includes('יוחננוף')) return CHAIN_SLUG_MAP['מ. יוחננוף ובניו'];
  if (name.includes('אושר עד')) return CHAIN_SLUG_MAP['אושר עד'];
  if (name.includes('וולט')) return CHAIN_SLUG_MAP['וולט מרקט'];
  if (name.includes('פרש')) return CHAIN_SLUG_MAP['פרש מרקט'];
  return null;
}

function resolveChainSlug(chainName: string, chainId?: string | null): string | null {
  if (chainName && CHAIN_SLUG_MAP[chainName]) return CHAIN_SLUG_MAP[chainName];
  if (chainId && CHAIN_ID_SLUG_MAP[chainId]) return CHAIN_ID_SLUG_MAP[chainId];
  if (!chainName) return null;
  const normalized = normalizeChainName(chainName);
  let slug: string | null = NORMALIZED_MAP[normalized] ?? null;
  if (!slug) {
    const canonical = NORMALIZED_ALIASES[normalized];
    if (canonical) slug = CHAIN_SLUG_MAP[canonical] ?? null;
  }
  if (!slug) slug = inferSlugByKeyword(normalized);
  return slug;
}

function truncate(value: string, maxChars: number): string {
  const text = value.trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3)).trim()}...`;
}

function splitLines(value: string, maxCharsPerLine: number, maxLines: number): string[] {
  const words = value.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [''];
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxCharsPerLine || current.length === 0) {
      current = candidate;
      continue;
    }
    lines.push(current);
    current = word;
    if (lines.length === maxLines - 1) break;
  }
  if (lines.length < maxLines && current) lines.push(current);
  if (words.join(' ').length > lines.join(' ').length && lines.length > 0) {
    lines[lines.length - 1] = truncate(lines[lines.length - 1], maxCharsPerLine);
  }
  return lines.slice(0, maxLines);
}

function splitLinesStrict(value: string, maxCharsPerLine: number, maxLines: number): string[] {
  const words = value.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [''];
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const safeWord = word.length > maxCharsPerLine ? truncate(word, maxCharsPerLine) : word;
    const candidate = current ? `${current} ${safeWord}` : safeWord;
    if (candidate.length <= maxCharsPerLine) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    current = safeWord;
    if (lines.length === maxLines - 1) break;
  }

  if (lines.length < maxLines && current) lines.push(current);
  const original = words.join(' ');
  const rendered = lines.join(' ');
  if (original.length > rendered.length && lines.length > 0) {
    lines[lines.length - 1] = truncate(lines[lines.length - 1], maxCharsPerLine);
  }
  return lines.slice(0, maxLines);
}

function fitFontSize(text: string, maxChars: number, maxSize: number, minSize: number): number {
  const length = Math.max(1, text.trim().length);
  if (length <= maxChars) return maxSize;
  return Math.max(minSize, Math.floor(maxSize * (maxChars / length)));
}

function priceFontSize(value: number | null, maxSize: number, minSize: number): number {
  const text = compactNumber(value);
  if (text.length <= 4) return maxSize;
  if (text.length <= 6) return Math.max(minSize, maxSize - 8);
  return minSize;
}

function splitLinesNoEllipsis(value: string, maxCharsPerLine: number, maxLines: number): string[] {
  const words = value.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [''];

  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxCharsPerLine || current.length === 0) {
      current = candidate;
      continue;
    }

    lines.push(current);
    current = word;
    if (lines.length === maxLines - 1) break;
  }

  const remainingWords = words.join(' ').slice(lines.join(' ').replace(/^\s+|\s+$/g, '').length).trim();
  if (lines.length < maxLines) {
    lines.push(current);
  } else if (remainingWords) {
    lines[lines.length - 1] = `${lines[lines.length - 1]} ${remainingWords}`.trim();
  }

  return lines.slice(0, maxLines);
}

function formatPrice(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '--';
  return `₪${value.toFixed(2)}`;
}

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toDataUri(contentType: string, buffer: Buffer): string {
  return `data:${contentType};base64,${buffer.toString('base64')}`;
}

function detectContentType(buffer: Buffer, fallback = 'application/octet-stream'): string {
  if (buffer.length >= 12) {
    const headerHex = buffer.subarray(0, 12).toString('hex');
    if (headerHex.startsWith('89504e470d0a1a0a')) return 'image/png';
    if (headerHex.startsWith('ffd8ff')) return 'image/jpeg';
    if (headerHex.startsWith('47494638')) return 'image/gif';
    if (headerHex.startsWith('52494646') && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  }
  return fallback;
}

async function readFileDataUri(filePath: string, contentType: string): Promise<string | null> {
  if (FILE_CACHE.has(filePath)) return FILE_CACHE.get(filePath) ?? null;
  try {
    let buffer = Buffer.from(await fs.readFile(filePath));
    let detectedType = detectContentType(buffer, contentType);
    if (detectedType === 'image/webp') {
      buffer = Buffer.from(await sharp(buffer).png().toBuffer());
      detectedType = 'image/png';
    }
    const dataUri = toDataUri(detectedType, buffer);
    FILE_CACHE.set(filePath, dataUri);
    return dataUri;
  } catch {
    FILE_CACHE.set(filePath, null);
    return null;
  }
}

async function fetchDataUri(url: string): Promise<string | null> {
  try {
    const response = await axios.get<ArrayBuffer>(url, {
      responseType: 'arraybuffer',
      timeout: 10000,
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      headers: {
        'User-Agent': 'Mozilla/5.0 AgaliSharePreview/1.0',
      },
    });
    const typeHeader = String(response.headers['content-type'] || 'image/jpeg');
    let buffer = Buffer.from(response.data);
    let type = detectContentType(buffer, typeHeader.split(';')[0]);
    if (type === 'image/webp') {
      buffer = Buffer.from(await sharp(buffer).png().toBuffer());
      type = 'image/png';
    }
    return toDataUri(type, buffer);
  } catch {
    return null;
  }
}

async function fetchText(url: string): Promise<string | null> {
  if (REMOTE_TEXT_CACHE.has(url)) return REMOTE_TEXT_CACHE.get(url) ?? null;
  try {
    const response = await axios.get<string>(url, {
      responseType: 'text',
      timeout: 10000,
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      headers: {
        'User-Agent': 'Mozilla/5.0 AgaliSharePreview/1.0',
      },
    });
    const text = response.data;
    REMOTE_TEXT_CACHE.set(url, text);
    return text;
  } catch {
    REMOTE_TEXT_CACHE.set(url, null);
    return null;
  }
}

async function buildEmbeddedFontCss(): Promise<string> {
  const weights = [400, 500, 600, 700, 800, 900];
  const subsets = ['hebrew', 'latin'];
  const declarations: string[] = [];

  for (const weight of weights) {
    for (const subset of subsets) {
      const filePath = path.resolve(
        process.cwd(),
        'node_modules',
        '@fontsource',
        'heebo',
        'files',
        `heebo-${subset}-${weight}-normal.woff`
      );
      const dataUri = await readFileDataUri(filePath, 'font/woff');
      if (!dataUri) continue;
      declarations.push(`
        @font-face {
          font-family: 'Rubik';
          font-style: normal;
          font-weight: ${weight};
          font-display: swap;
          src: url(${dataUri}) format('woff');
        }
      `);
    }
  }

  if (declarations.length > 0) return declarations.join('\n');

  const cssUrl = 'https://fonts.googleapis.com/css2?family=Heebo:wght@400;500;600;700;800;900&display=swap';
  const googleCss = await fetchText(cssUrl);
  if (!googleCss) return '';
  const urlMatches = [...googleCss.matchAll(/url\((https:[^)]+)\)/g)].map((match) => match[1]);
  const fontDataUris = await Promise.all(urlMatches.map((url) => fetchDataUri(url)));
  let index = 0;
  return googleCss.replace(/url\((https:[^)]+)\)/g, () => {
    const dataUri = fontDataUris[index++];
    return dataUri ? `url(${dataUri})` : 'local(sans-serif)';
  });
}

function getThemePalette(theme: ShareTheme) {
  if (theme === 'light') {
    return {
      bgStart: '#f0f4ff',
      bgEnd: '#e8ecff',
      panel: 'rgba(255,255,255,0.72)',
      panelBorder: 'rgba(99,102,241,0.18)',
      text: '#0f0f2d',
      muted: '#5b6285',
      strike: 'rgba(15,15,45,0.38)',
      promo: '#059669',
      accent: '#6366f1',
      accentSoft: 'rgba(99,102,241,0.12)',
      badgeBg: 'rgba(236,72,153,0.12)',
      badgeText: '#db2777',
      line: 'rgba(15,15,45,0.08)',
    };
  }

  return {
    bgStart: '#060614',
    bgEnd: '#0d0d2b',
    panel: 'rgba(255,255,255,0.06)',
    panelBorder: 'rgba(255,255,255,0.1)',
    text: '#ffffff',
    muted: 'rgba(255,255,255,0.62)',
    strike: 'rgba(255,255,255,0.28)',
    promo: '#10b981',
    accent: '#818cf8',
    accentSoft: 'rgba(129,140,248,0.16)',
    badgeBg: 'rgba(236,72,153,0.14)',
    badgeText: '#f472b6',
    line: 'rgba(255,255,255,0.08)',
  };
}

function getCopy(lang: ShareLang) {
  if (lang === 'fr') {
    return {
      compare: 'Compare les prix par magasin',
      byCity: 'Ville',
      bestOffers: 'Meilleurs prix',
      promo: 'Promo',
      siteLine: 'agali.live • Comparateur de prix supermarché',
    };
  }
  if (lang === 'en') {
    return {
      compare: 'Compare supermarket prices by store',
      byCity: 'City',
      bestOffers: 'Best prices',
      promo: 'Deal',
      siteLine: 'agali.live • Supermarket price comparison',
    };
  }
  return {
    compare: 'השוואת מחירים לפי חנות',
    byCity: 'עיר',
    bestOffers: 'המחירים הטובים ביותר',
    promo: 'מבצע',
    siteLine: 'agali.live • השוואת מחירים בסופרמרקטים',
  };
}

export function parseShareTheme(raw: unknown): ShareTheme {
  return raw === 'light' ? 'light' : 'dark';
}

export function parseShareLang(raw: unknown): ShareLang {
  return raw === 'fr' || raw === 'en' ? raw : 'he';
}

export async function getProductShareMeta(
  prisma: PrismaClient,
  barcode: string,
  city: string
): Promise<{ itemName: string; manufacturerName: string; offers: ShareOffer[] }> {
  const [productRows, offerRows] = await Promise.all([
    prisma.$queryRaw<ProductRow[]>(Prisma.sql`
      SELECT item_name, manufacturer_name
      FROM products
      WHERE item_code = ${barcode}::text
      LIMIT 1
    `),
    prisma.$queryRaw<OfferRow[]>(Prisma.sql`
      SELECT
        o.chain_id,
        s_name.chain_name,
        o.store_id,
        o.store_name,
        o.price,
        o.promo_price,
        o.effective_price
      FROM public.get_offers_for_item_code(
        ${barcode}::text,
        ${city || null}::text,
        ${null}::text,
        ${120}::integer,
        ${0}::integer,
        ${null}::text
      ) o
      LEFT JOIN LATERAL (
        SELECT chain_name FROM stores WHERE chain_id = o.chain_id AND store_id = o.store_id LIMIT 1
      ) s_name ON true
      ORDER BY o.effective_price ASC NULLS LAST, o.updated_at DESC NULLS LAST, o.store_id ASC
    `),
  ]);

  const product = productRows[0];
  const rawOffers = offerRows.map((row) => ({
    chainId: row.chain_id,
    chainName: row.chain_name?.trim() || 'Unknown',
    storeName: row.store_name?.trim() || row.chain_name?.trim() || 'Unknown store',
    price: toNullableNumber(row.price),
    promoPrice: toNullableNumber(row.promo_price),
    effectivePrice: toNullableNumber(row.effective_price),
  }));

  const bestOffersByChain = new Map<string, typeof rawOffers[number]>();
  for (const offer of rawOffers) {
    const chainKey = `${offer.chainId || ''}::${offer.chainName}`;
    if (!bestOffersByChain.has(chainKey)) {
      bestOffersByChain.set(chainKey, offer);
    }
  }

  const topChainOffers = Array.from(bestOffersByChain.values()).slice(0, 4);

  const offers = await Promise.all(
    topChainOffers.map(async (offer) => {
      const slug = resolveChainSlug(offer.chainName, offer.chainId);
      const logoUrl = slug ? `${PUBLIC_FRONTEND_BASE_URL}/images/stores/${slug}.jpg` : '';
      const logoDataUri = slug ? await fetchDataUri(logoUrl) : null;
      return { ...offer, logoDataUri };
    })
  );

  return {
    itemName: product?.item_name?.trim() || barcode,
    manufacturerName: product?.manufacturer_name?.trim() || '',
    offers,
  };
}

async function generateProductShareImageLegacy(
  prisma: PrismaClient,
  barcode: string,
  city: string,
  theme: ShareTheme,
  lang: ShareLang
): Promise<Buffer> {
  const isRtl = lang === 'he';
  const palette = getThemePalette(theme);
  const copy = getCopy(lang);
  const meta = await getProductShareMeta(prisma, barcode, city);
  const fontCss = await buildEmbeddedFontCss();
  const logoDataUri =
    (await readFileDataUri(LOCAL_AGALI_LOGO_PATH, 'image/png')) ??
    (await fetchDataUri(`${PUBLIC_FRONTEND_BASE_URL}/logo.png`));
  const productImageCandidates = [
    getProductImageUrl(barcode),
    `https://m.pricez.co.il/ProductPictures/200x/${encodeURIComponent(barcode)}.jpg`,
    `https://res.cloudinary.com/dprve5nst/image/upload/w_360,h_360,c_pad,b_white/products/${encodeURIComponent(barcode)}.jpg`,
  ].filter(Boolean) as string[];
  let productImageDataUri: string | null = null;
  for (const url of productImageCandidates) {
    productImageDataUri = await fetchDataUri(url);
    if (productImageDataUri) break;
  }
  const productLines = splitLines(meta.itemName, 30, 2);
  const manufacturer = truncate(meta.manufacturerName || copy.compare, 34);
  const safeCity = truncate(city || 'תל אביב', 18);
  const cityLabelX = isRtl ? 918 : 904;
  const cityValueX = isRtl ? 1100 : 936;
  const cityValueAnchor = isRtl ? 'end' : 'start';
  const heroCardY = 182;
  const heroCardHeight = 212;
  const titleCardX = 56;
  const titleCardWidth = 676;
  const titleX = titleCardX + titleCardWidth - 28;
  const titleAnchor = 'end';
  const imageCardX = 804;
  const imageCardWidth = 262;
  const gridStartX = 48;
  const gridStartY = 438;
  const cardGapX = 24;
  const cardGapY = 20;
  const cardWidth = 540;
  const cardHeight = 128;

  const rows = meta.offers.map((offer, index) => {
    const hasDiscount =
      offer.price !== null &&
      offer.effectivePrice !== null &&
      Number.isFinite(offer.price) &&
      Number.isFinite(offer.effectivePrice) &&
      offer.effectivePrice < offer.price;
    const column = index % 2;
    const row = Math.floor(index / 2);
    const x = gridStartX + column * (cardWidth + cardGapX);
    const y = gridStartY + row * (cardHeight + cardGapY);
    const nameLines = splitLinesNoEllipsis(offer.chainName, isRtl ? 11 : 12, 2).map(escapeXml);
     const contentLeft = x + 24;
     const contentRight = x + cardWidth - 24;
    const logoCardWidth = 108;
    const logoCardHeight = 86;
     const logoCardX = isRtl ? contentRight - logoCardWidth : contentLeft;
    const logoImageX = logoCardX;
    const logoImageY = y + 18;
    const logoImageWidth = logoCardWidth;
    const logoImageHeight = logoCardHeight;
    const nameX = isRtl ? logoCardX - 18 : logoCardX + logoCardWidth + 18;
    const nameAnchor = isRtl ? 'end' : 'start';
    const priceX = isRtl ? x + 30 : contentRight + 2;
    const priceAnchor = isRtl ? 'start' : 'end';
    const promoBadgeX = isRtl ? x + 24 : contentRight - 124;
    const promoBadgeTextX = promoBadgeX + 56;
    const promoBadge = hasDiscount
      ? `<rect x="${promoBadgeX}" y="${y + 20}" width="112" height="32" rx="16" fill="${palette.badgeBg}" />
         <text x="${promoBadgeTextX}" y="${y + 42}" text-anchor="middle" font-size="15" font-weight="700" fill="${palette.badgeText}" font-family="Rubik, sans-serif">${escapeXml(copy.promo)}</text>`
      : '';
    const priceBlock = hasDiscount
      ? `<text x="${priceX}" y="${y + 36}" text-anchor="${priceAnchor}" font-size="18" font-weight="600" fill="${palette.strike}" text-decoration="line-through" font-family="Rubik, sans-serif">${escapeXml(formatPrice(offer.price))}</text>
        <text x="${priceX}" y="${y + 88}" text-anchor="${priceAnchor}" font-size="44" font-weight="800" fill="${palette.promo}" font-family="Rubik, sans-serif">${escapeXml(formatPrice(offer.effectivePrice))}</text>`
      : `<text x="${priceX}" y="${y + 80}" text-anchor="${priceAnchor}" font-size="44" font-weight="800" fill="${palette.promo}" font-family="Rubik, sans-serif">${escapeXml(formatPrice(offer.effectivePrice ?? offer.price))}</text>`;
    const logoMarkup = offer.logoDataUri
      ? `<clipPath id="logoCardClip${index}">
          <rect x="${logoCardX}" y="${y + 18}" width="${logoCardWidth}" height="${logoCardHeight}" rx="20" ry="20" />
        </clipPath>
        <image href="${offer.logoDataUri}" x="${logoImageX}" y="${logoImageY}" width="${logoImageWidth}" height="${logoImageHeight}" preserveAspectRatio="xMidYMid slice" clip-path="url(#logoCardClip${index})" />`
      : `<rect x="${logoCardX}" y="${y + 18}" width="${logoCardWidth}" height="${logoCardHeight}" rx="20" fill="${palette.accentSoft}" stroke="${palette.panelBorder}" />
        <text x="${logoCardX + logoCardWidth / 2}" y="${y + 70}" text-anchor="middle" font-size="28" font-weight="800" fill="${palette.accent}" font-family="Rubik, sans-serif">${escapeXml((offer.chainName || offer.storeName || '?').slice(0, 1))}</text>`;

    return `
      <rect x="${x}" y="${y}" width="${cardWidth}" height="${cardHeight}" rx="24" fill="${palette.panel}" stroke="${palette.line}" />
      ${logoMarkup}
      <text x="${nameX}" y="${nameLines.length > 1 ? y + 62 : y + 76}" text-anchor="${nameAnchor}" font-size="24" font-weight="700" fill="${palette.text}" font-family="Rubik, sans-serif">${nameLines[0] || ''}</text>
      ${nameLines[1] ? `<text x="${nameX}" y="${y + 92}" text-anchor="${nameAnchor}" font-size="24" font-weight="700" fill="${palette.text}" font-family="Rubik, sans-serif">${nameLines[1]}</text>` : ''}
      ${promoBadge}
      ${priceBlock}
    `;
  }).join('');

  const productImageMarkup = productImageDataUri
     ? `<image href="${productImageDataUri}" x="${imageCardX}" y="${heroCardY}" width="${imageCardWidth}" height="${heroCardHeight}" preserveAspectRatio="xMidYMid meet" clip-path="url(#productImageClip)" />`
     : `<rect x="${imageCardX}" y="${heroCardY}" width="${imageCardWidth}" height="${heroCardHeight}" rx="32" fill="${palette.accentSoft}" />
       <text x="${imageCardX + imageCardWidth / 2}" y="${heroCardY + 122}" text-anchor="middle" font-size="72" font-weight="700" fill="${palette.accent}" font-family="Rubik, sans-serif">A</text>`;

  const svg = `
  <svg width="${CANVAS_WIDTH}" height="${CANVAS_HEIGHT}" viewBox="0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <style>
        ${fontCss}
      </style>
      <linearGradient id="bg" x1="0" y1="0" x2="${CANVAS_WIDTH}" y2="${CANVAS_HEIGHT}" gradientUnits="userSpaceOnUse">
        <stop stop-color="${palette.bgStart}" />
        <stop offset="1" stop-color="${palette.bgEnd}" />
      </linearGradient>
      <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow dx="0" dy="16" stdDeviation="24" flood-color="rgba(0,0,0,0.18)" />
      </filter>
      <clipPath id="productImageClip">
        <rect x="${imageCardX}" y="${heroCardY}" width="${imageCardWidth}" height="${heroCardHeight}" rx="32" ry="32" />
      </clipPath>
    </defs>
    <rect width="${CANVAS_WIDTH}" height="${CANVAS_HEIGHT}" fill="url(#bg)" />
    <circle cx="1090" cy="120" r="180" fill="${palette.accentSoft}" />
    <circle cx="138" cy="710" r="190" fill="${palette.accentSoft}" />

    <rect x="40" y="34" width="1120" height="712" rx="38" fill="transparent" stroke="${palette.line}" />

    <g>
      <rect x="56" y="34" width="1088" height="124" rx="32" fill="${palette.panel}" stroke="${palette.panelBorder}" />
      ${logoDataUri ? `<image href="${logoDataUri}" x="70" y="42" width="108" height="108" preserveAspectRatio="xMidYMid meet" />` : `<rect x="70" y="42" width="108" height="108" rx="24" fill="${palette.accentSoft}" />`}
      <text x="198" y="91" font-size="56" font-weight="800" fill="${palette.text}" font-family="Rubik, sans-serif">AGALI</text>
      <text x="198" y="126" font-size="17" font-weight="600" fill="${palette.muted}" font-family="Rubik, sans-serif">${escapeXml(copy.compare)}</text>
      <rect x="900" y="68" width="220" height="56" rx="24" fill="${palette.accentSoft}" stroke="${palette.panelBorder}" />
      <text x="1010" y="103" text-anchor="middle" font-size="23" font-weight="700" fill="${palette.text}" font-family="Rubik, sans-serif">${escapeXml(safeCity)}</text>
    </g>

    <g filter="url(#shadow)">
      <rect x="${titleCardX}" y="${heroCardY}" width="${titleCardWidth}" height="${heroCardHeight}" rx="32" fill="${palette.panel}" stroke="${palette.panelBorder}" />
      <text x="${titleX}" y="236" text-anchor="${titleAnchor}" font-size="17" font-weight="700" fill="${palette.accent}" font-family="Rubik, sans-serif">${escapeXml(copy.bestOffers)}</text>
      <text x="${titleX}" y="286" text-anchor="${titleAnchor}" font-size="38" font-weight="800" fill="${palette.text}" font-family="Rubik, sans-serif">${escapeXml(productLines[0] || '')}</text>
      ${productLines[1] ? `<text x="${titleX}" y="330" text-anchor="${titleAnchor}" font-size="38" font-weight="800" fill="${palette.text}" font-family="Rubik, sans-serif">${escapeXml(productLines[1])}</text>` : ''}
      <text x="${titleX}" y="372" text-anchor="${titleAnchor}" font-size="24" font-weight="600" fill="${palette.muted}" font-family="Rubik, sans-serif">${escapeXml(manufacturer)}</text>

      <rect x="${imageCardX}" y="${heroCardY}" width="${imageCardWidth}" height="${heroCardHeight}" rx="32" fill="rgba(255,255,255,0.98)" stroke="${palette.panelBorder}" />
      ${productImageMarkup}
    </g>

    ${rows}

    <g>
      <line x1="56" y1="734" x2="1144" y2="734" stroke="${palette.line}" />
      <text x="600" y="764" text-anchor="middle" font-size="16" font-weight="700" fill="${palette.muted}" font-family="Rubik, sans-serif">${escapeXml(copy.siteLine)}</text>
    </g>
  </svg>`;

  const resvg = new Resvg(svg, {
    fitTo: {
      mode: 'width',
      value: SHARE_IMAGE_WIDTH,
    },
    font: {
      loadSystemFonts: true,
      defaultFontFamily: 'Noto Sans',
    },
  });

  return resvg.render().asPng();
}

type SharePromoInput = {
  itemCode: string;
  chainId: string;
  storeId?: string;
  promotionId?: string;
  city?: string;
};

type SharePromotionScopeInput = {
  city: string;
  chainId?: string;
  chainName?: string;
  storeId?: string;
};

type PromotionShareRow = {
  item_code: string;
  item_name: string | null;
  manufacturer_name: string | null;
  chain_id: string;
  chain_name: string | null;
  store_id: string;
  store_name: string | null;
  city: string | null;
  price: unknown;
  promo_price: unknown;
  effective_price: unknown;
  discount_amount: unknown;
  discount_percent: unknown;
  smart_score: unknown;
  promotion_id: string | null;
  promotion_description: string | null;
  promotion_end_date: Date | string | null;
  updated_at: Date | string | null;
};

type SharePromotion = {
  itemCode: string;
  itemName: string;
  manufacturerName: string;
  chainId: string;
  chainName: string;
  storeId: string;
  storeName: string;
  city: string;
  price: number | null;
  promoPrice: number | null;
  effectivePrice: number | null;
  discountAmount: number | null;
  discountPercent: number | null;
  promotionId: string | null;
  promotionDescription: string | null;
  promotionEndDate: string | null;
  imageDataUri: string | null;
  logoDataUri: string | null;
};

type ShoppingListShareItem = {
  productId: string;
  mappedItemCode: string | null;
  name: string;
  quantity: number;
  picked: boolean;
  imageDataUri: string | null;
};

function compactNumber(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '--';
  return value % 1 === 0 ? value.toFixed(0) : value.toFixed(2);
}

function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value <= 0) return '';
  return `-${Math.round(value)}%`;
}

function svgTextLines(lines: string[], options: {
  x: number;
  y: number;
  lineHeight: number;
  size: number;
  weight: number;
  fill: string;
  anchor?: 'start' | 'middle' | 'end';
  family?: string;
}): string {
  return lines
    .map((line, index) => (
      `<text x="${options.x}" y="${options.y + index * options.lineHeight}" text-anchor="${options.anchor || 'start'}" font-size="${options.size}" font-weight="${options.weight}" fill="${options.fill}" font-family="${options.family || 'Rubik, sans-serif'}">${escapeXml(line)}</text>`
    ))
    .join('');
}

function getSocialCopy(lang: ShareLang) {
  if (lang === 'fr') {
    return {
      productEyebrow: 'Compare les prix en direct',
      productTitle: 'Meilleur prix trouve sur Agali',
      listEyebrow: 'Liste de courses partagee',
      listTitle: 'Courses plus simples, ensemble',
      promoEyebrow: 'Promotion reperee',
      promosEyebrow: 'Promos chaudes en magasin',
      siteTitle: 'Agali',
      siteSubtitle: 'Compare les prix, trouve les meilleures promos, partage tes listes.',
      chainCount: '30+ chaînes de magasins',
      chainCountNumber: '30+',
      chainCountLabel: 'chaînes de magasins',
      openCta: 'Ouvrir sur agali.live',
      items: 'articles',
      stores: 'magasins',
      bestDeals: 'Meilleures offres',
      livePrices: 'Prix et promos en temps reel',
    };
  }
  if (lang === 'en') {
    return {
      productEyebrow: 'Live supermarket comparison',
      productTitle: 'Best price found on Agali',
      listEyebrow: 'Shared shopping list',
      listTitle: 'Shop smarter together',
      promoEyebrow: 'Deal spotted',
      promosEyebrow: 'Hot store deals',
      siteTitle: 'Agali',
      siteSubtitle: 'Compare prices, discover the best deals, and share shopping lists.',
      chainCount: '30+ store chains',
      chainCountNumber: '30+',
      chainCountLabel: 'store chains',
      openCta: 'Open on agali.live',
      items: 'items',
      stores: 'stores',
      bestDeals: 'Best deals',
      livePrices: 'Live prices and deals',
    };
  }
  return {
    productEyebrow: 'השוואת מחירים חיה',
    productTitle: 'המחיר הטוב ביותר ב-Agali',
    listEyebrow: 'רשימת קניות משותפת',
    listTitle: 'קניות חכמות ביחד',
    promoEyebrow: 'מבצע חם',
    promosEyebrow: 'מבצעים חזקים בחנויות',
    siteTitle: 'Agali',
    siteSubtitle: 'משווים מחירים, מוצאים מבצעים ומשתפים רשימות קניות.',
    chainCount: '30+ רשתות שיווק',
    chainCountNumber: '30+',
    chainCountLabel: 'רשתות שיווק',
    openCta: 'פתיחה ב-agali.live',
    items: 'פריטים',
    stores: 'חנויות',
    bestDeals: 'ההצעות הכי טובות',
    livePrices: 'מחירים ומבצעים בזמן אמת',
  };
}

function socialPalette(theme: ShareTheme) {
  if (theme === 'light') {
    return {
      bg: '#f0f1f8',
      bg2: '#e6ecfb',
      card: '#ffffff',
      card2: '#f7f8ff',
      text: '#12122a',
      muted: 'rgba(18,18,42,0.62)',
      faint: 'rgba(18,18,42,0.34)',
      border: 'rgba(0,0,40,0.10)',
      brand: '#6366f1',
      purple: '#a855f7',
      pink: '#ec4899',
      green: '#10b981',
      amber: '#f59e0b',
      red: '#ef4444',
      shadow: 'rgba(15,23,42,0.16)',
    };
  }

  return {
    bg: '#060614',
    bg2: '#0d0d2b',
    card: '#10112d',
    card2: '#0b0b21',
    text: '#ffffff',
    muted: 'rgba(255,255,255,0.66)',
    faint: 'rgba(255,255,255,0.34)',
    border: 'rgba(255,255,255,0.10)',
    brand: '#818cf8',
    purple: '#a78bfa',
    pink: '#f472b6',
    green: '#34d399',
    amber: '#fbbf24',
    red: '#fb7185',
    shadow: 'rgba(0,0,0,0.34)',
  };
}

async function renderSocialSvg(svg: string): Promise<Buffer> {
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: SHARE_IMAGE_WIDTH },
    font: {
      loadSystemFonts: true,
      defaultFontFamily: 'Rubik',
    },
  });
  return resvg.render().asPng();
}

async function socialDefs(theme: ShareTheme): Promise<{ fontCss: string; logoDataUri: string | null }> {
  const [fontCss, logoDataUri] = await Promise.all([
    buildEmbeddedFontCss(),
    readFileDataUri(LOCAL_AGALI_LOGO_PATH, 'image/png').then((local) => local ?? fetchDataUri(`${PUBLIC_FRONTEND_BASE_URL}/logo.png`)),
  ]);

  return { fontCss, logoDataUri };
}

function socialFrame({
  theme,
  lang,
  fontCss,
  logoDataUri,
  body,
}: {
  theme: ShareTheme;
  lang: ShareLang;
  fontCss: string;
  logoDataUri: string | null;
  body: string;
}): string {
  const p = socialPalette(theme);
  const dir = lang === 'he' ? 'rtl' : 'ltr';
  return `<svg width="${SHARE_IMAGE_WIDTH}" height="${SHARE_IMAGE_HEIGHT}" viewBox="0 0 ${SHARE_IMAGE_WIDTH} ${SHARE_IMAGE_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <style>${fontCss}</style>
      <linearGradient id="socialBg" x1="0" y1="0" x2="1200" y2="630" gradientUnits="userSpaceOnUse">
        <stop stop-color="${p.bg}" />
        <stop offset="0.56" stop-color="${p.bg2}" />
        <stop offset="1" stop-color="${theme === 'light' ? '#f7e9f7' : '#170b21'}" />
      </linearGradient>
      <linearGradient id="brandGradient" x1="0" y1="0" x2="1" y2="1">
        <stop stop-color="#6366f1" />
        <stop offset="0.52" stop-color="#a855f7" />
        <stop offset="1" stop-color="#ec4899" />
      </linearGradient>
      <filter id="softShadow" x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow dx="0" dy="18" stdDeviation="22" flood-color="${p.shadow}" />
      </filter>
      <pattern id="gridPattern" width="48" height="48" patternUnits="userSpaceOnUse">
        <path d="M 48 0 L 0 0 0 48" fill="none" stroke="${theme === 'light' ? 'rgba(99,102,241,0.08)' : 'rgba(255,255,255,0.045)'}" stroke-width="1" />
      </pattern>
    </defs>
    <rect width="1200" height="630" fill="url(#socialBg)" />
    <rect width="1200" height="630" fill="url(#gridPattern)" opacity="0.75" />
    <rect x="44" y="34" width="1112" height="562" rx="34" fill="${theme === 'light' ? 'rgba(255,255,255,0.54)' : 'rgba(255,255,255,0.035)'}" stroke="${p.border}" />

    <g direction="${dir}">
      <g transform="translate(72 56)">
        ${logoDataUri ? `<image href="${logoDataUri}" x="0" y="-8" width="78" height="78" preserveAspectRatio="xMidYMid meet" />` : `<rect x="0" y="0" width="62" height="62" rx="16" fill="url(#brandGradient)" />`}
        <text x="92" y="30" font-size="34" font-weight="900" fill="${p.text}" font-family="Rubik, sans-serif">Agali</text>
        <text x="92" y="56" font-size="15" font-weight="700" fill="${p.muted}" font-family="Rubik, sans-serif">agali.live</text>
      </g>
      ${body}
    </g>
  </svg>`;
}

async function productImageDataUri(itemCode: string): Promise<string | null> {
  const candidates = [
    getProductImageUrl(itemCode),
    `https://m.pricez.co.il/ProductPictures/200x/${encodeURIComponent(itemCode)}.jpg`,
    `https://res.cloudinary.com/dprve5nst/image/upload/w_460,h_460,c_pad,b_white/products/${encodeURIComponent(itemCode)}.jpg`,
  ].filter(Boolean) as string[];

  for (const url of candidates) {
    const dataUri = await fetchDataUri(url);
    if (dataUri) return dataUri;
  }
  return null;
}

async function catalogOrProductImageDataUri(productId: string, mappedItemCode: string | null): Promise<string | null> {
  const candidates = [
    productId && !productId.startsWith('custom_') ? getCatalogImageUrl(productId) : null,
    mappedItemCode ? getProductImageUrl(mappedItemCode) : null,
    mappedItemCode ? `https://m.pricez.co.il/ProductPictures/200x/${encodeURIComponent(mappedItemCode)}.jpg` : null,
  ].filter(Boolean) as string[];

  for (const url of candidates) {
    const dataUri = await fetchDataUri(url);
    if (dataUri) return dataUri;
  }
  return null;
}

async function chainLogoDataUri(chainName: string, chainId?: string | null): Promise<string | null> {
  const slug = resolveChainSlug(chainName, chainId);
  if (!slug) return null;
  return fetchDataUri(`${PUBLIC_FRONTEND_BASE_URL}/images/stores/${slug}.jpg`);
}

function mapPromotionRow(row: PromotionShareRow): Omit<SharePromotion, 'imageDataUri' | 'logoDataUri'> {
  const effectivePrice = toNullableNumber(row.effective_price) ?? toNullableNumber(row.promo_price);
  const price = toNullableNumber(row.price);
  const discountPercent =
    toNullableNumber(row.discount_percent) ??
    (price !== null && effectivePrice !== null && price > 0 ? (1 - effectivePrice / price) * 100 : null);

  return {
    itemCode: row.item_code,
    itemName: row.item_name?.trim() || row.item_code,
    manufacturerName: row.manufacturer_name?.trim() || '',
    chainId: row.chain_id,
    chainName: row.chain_name?.trim() || row.chain_id,
    storeId: row.store_id,
    storeName: row.store_name?.trim() || row.store_id,
    city: row.city?.trim() || '',
    price,
    promoPrice: toNullableNumber(row.promo_price),
    effectivePrice,
    discountAmount: toNullableNumber(row.discount_amount),
    discountPercent,
    promotionId: row.promotion_id || null,
    promotionDescription: row.promotion_description || null,
    promotionEndDate: row.promotion_end_date ? new Date(row.promotion_end_date).toISOString().slice(0, 10) : null,
  };
}

async function hydratePromotion(row: PromotionShareRow): Promise<SharePromotion> {
  const promo = mapPromotionRow(row);
  const [imageDataUri, logoDataUri] = await Promise.all([
    productImageDataUri(promo.itemCode),
    chainLogoDataUri(promo.chainName, promo.chainId),
  ]);
  return { ...promo, imageDataUri, logoDataUri };
}

export async function getPromoShareMeta(prisma: PrismaClient, input: SharePromoInput): Promise<SharePromotion | null> {
  const itemCode = input.itemCode.trim();
  const chainId = input.chainId.trim();
  if (!itemCode || !chainId) return null;

  const rows = await prisma.$queryRaw<PromotionShareRow[]>(Prisma.sql`
    SELECT
      c.item_code, c.item_name, c.manufacturer_name,
      c.chain_id, c.chain_name, c.store_id, c.store_name, c.city,
      c.price, c.promo_price, c.effective_price, c.discount_amount, c.discount_percent,
      c.smart_score, c.promotion_id, c.promotion_description, c.promotion_end_date, c.updated_at
    FROM top_promotions_cache c
    WHERE c.scope_type = 'store'
      AND c.item_code = ${itemCode}::text
      AND c.chain_id = ${chainId}::text
      AND (${input.storeId || null}::text IS NULL OR c.store_id = ${input.storeId || null}::text)
      AND (${input.promotionId || null}::text IS NULL OR c.promotion_id = ${input.promotionId || null}::text)
      AND (${input.city || null}::text IS NULL OR c.city = ${input.city || null}::text)
      AND c.price IS NOT NULL
      AND c.effective_price IS NOT NULL
      AND c.effective_price < c.price
    ORDER BY
      CASE WHEN ${input.promotionId || null}::text IS NOT NULL AND c.promotion_id = ${input.promotionId || null}::text THEN 0 ELSE 1 END,
      c.smart_score DESC NULLS LAST,
      c.updated_at DESC NULLS LAST
    LIMIT 1
  `);

  if (!rows[0]) return null;
  return hydratePromotion(rows[0]);
}

export async function getPromotionsShareMeta(
  prisma: PrismaClient,
  input: SharePromotionScopeInput
): Promise<{ title: string; subtitle: string; promotions: SharePromotion[] }> {
  const city = input.city.trim();
  if (!city) {
    return { title: 'Agali', subtitle: '', promotions: [] };
  }

  const rows = await prisma.$queryRaw<PromotionShareRow[]>(Prisma.sql`
    WITH scoped AS (
      SELECT
        c.item_code, c.item_name, c.manufacturer_name,
        c.chain_id, c.chain_name, c.store_id, c.store_name, c.city,
        c.price, c.promo_price, c.effective_price, c.discount_amount, c.discount_percent,
        c.smart_score, c.promotion_id, c.promotion_description, c.promotion_end_date, c.updated_at,
        ROW_NUMBER() OVER (
          PARTITION BY c.item_code
          ORDER BY c.smart_score DESC NULLS LAST, c.discount_percent DESC NULLS LAST
        ) AS rn
      FROM top_promotions_cache c
      WHERE c.scope_type = 'store'
        AND c.city = ${city}::text
        AND c.has_image IS TRUE
        AND (${input.chainId || null}::text IS NULL OR c.chain_id = ${input.chainId || null}::text)
        AND (${input.chainName || null}::text IS NULL OR lower(c.chain_name) = lower(${input.chainName || null}::text))
        AND (${input.storeId || null}::text IS NULL OR c.store_id = ${input.storeId || null}::text)
        AND c.price IS NOT NULL
        AND c.effective_price IS NOT NULL
        AND c.effective_price < c.price
    )
    SELECT *
    FROM scoped
    WHERE rn = 1
    ORDER BY smart_score DESC NULLS LAST, discount_percent DESC NULLS LAST
    LIMIT 6
  `);

  const promotions = await Promise.all(rows.map(hydratePromotion));
  const first = promotions[0];
  const scopeTitle = input.storeId && first
    ? (first.storeName || first.chainName)
    : input.chainName || first?.chainName || '';
  const title = scopeTitle ? `${scopeTitle} · ${city}` : city;
  return {
    title,
    subtitle: first?.city || city,
    promotions,
  };
}

export async function generateProductShareImage(
  prisma: PrismaClient,
  barcode: string,
  city: string,
  theme: ShareTheme,
  lang: ShareLang
): Promise<Buffer> {
  const p = socialPalette(theme);
  const copy = getSocialCopy(lang);
  const [{ fontCss, logoDataUri }, meta, mainImageDataUri] = await Promise.all([
    socialDefs(theme),
    getProductShareMeta(prisma, barcode, city),
    productImageDataUri(barcode),
  ]);
  const titleLines = splitLinesStrict(meta.itemName, 24, 2);
  const titleSize = fitFontSize(titleLines[0] || meta.itemName, 18, 46, 34);
  const manufacturer = truncate(meta.manufacturerName || copy.productEyebrow, 30);
  const topOffers = meta.offers.slice(0, 4);
  const bestOffer = topOffers[0] ?? null;
  const bestPrice = bestOffer ? (bestOffer.effectivePrice ?? bestOffer.promoPrice ?? bestOffer.price) : null;
  const bestPriceText = compactNumber(bestPrice);
  const bestPriceSize = priceFontSize(bestPrice, 62, 44);
  const hasDiscount = Boolean(bestOffer?.price != null && bestOffer?.effectivePrice != null && bestOffer.effectivePrice < bestOffer.price);
  const productCard = { x: 72, y: 158, w: 430, h: 374 };
  const textX = 1088;
  const titleY = titleLines.length > 1 ? 220 : 250;

  const comparisonDots = topOffers.slice(1, 4).map((offer, index) => {
    const price = offer.effectivePrice ?? offer.promoPrice ?? offer.price;
    const x = 562 + index * 168;
    return `<g>
      <rect x="${x}" y="506" width="146" height="54" rx="18" fill="${theme === 'light' ? '#ffffff' : 'rgba(255,255,255,0.06)'}" stroke="${p.border}" />
      <clipPath id="miniOfferLogo${index}"><rect x="${x + 10}" y="514" width="38" height="38" rx="12" /></clipPath>
      ${offer.logoDataUri ? `<image href="${offer.logoDataUri}" x="${x + 10}" y="514" width="38" height="38" preserveAspectRatio="xMidYMid slice" clip-path="url(#miniOfferLogo${index})" />` : `<rect x="${x + 10}" y="514" width="38" height="38" rx="12" fill="rgba(99,102,241,0.18)" />`}
      <text x="${x + 134}" y="536" text-anchor="end" font-size="14" font-weight="700" fill="${p.muted}" font-family="Rubik, sans-serif">${escapeXml(truncate(offer.chainName, 10))}</text>
      <text x="${x + 134}" y="555" text-anchor="end" font-size="17" font-weight="900" fill="${p.green}" font-family="Rubik, sans-serif">₪${escapeXml(compactNumber(price))}</text>
    </g>`;
  }).join('');

  const body = `
    <g filter="url(#softShadow)">
      <rect x="${productCard.x}" y="${productCard.y}" width="${productCard.w}" height="${productCard.h}" rx="36" fill="${p.card}" stroke="${p.border}" />
      <rect x="${productCard.x + 28}" y="${productCard.y + 28}" width="${productCard.w - 56}" height="${productCard.h - 56}" rx="28" fill="#ffffff" stroke="${p.border}" />
      ${mainImageDataUri
        ? `<image href="${mainImageDataUri}" x="${productCard.x + 54}" y="${productCard.y + 58}" width="${productCard.w - 108}" height="${productCard.h - 116}" preserveAspectRatio="xMidYMid meet" />`
        : `<text x="${productCard.x + productCard.w / 2}" y="376" text-anchor="middle" font-size="112" font-weight="800" fill="url(#brandGradient)" font-family="Rubik, sans-serif">A</text>`}
    </g>
    <text x="${textX}" y="174" text-anchor="end" font-size="17" font-weight="700" fill="${p.brand}" font-family="Rubik, sans-serif">${escapeXml(copy.productEyebrow)}</text>
    <text x="${textX}" y="${titleY}" text-anchor="end" font-size="${titleSize}" font-weight="800" fill="${p.text}" font-family="Rubik, sans-serif">${escapeXml(titleLines[0] || '')}</text>
    ${titleLines[1] ? `<text x="${textX}" y="${titleY + titleSize + 4}" text-anchor="end" font-size="${titleSize}" font-weight="800" fill="${p.text}" font-family="Rubik, sans-serif">${escapeXml(titleLines[1])}</text>` : ''}
    <text x="${textX}" y="${titleY + (titleLines.length > 1 ? titleSize * 2 + 28 : titleSize + 28)}" text-anchor="end" font-size="21" font-weight="600" fill="${p.muted}" font-family="Rubik, sans-serif">${escapeXml(manufacturer)}</text>

    <g filter="url(#softShadow)">
      <rect x="560" y="342" width="528" height="142" rx="30" fill="${p.card}" stroke="${p.border}" />
      <rect x="584" y="366" width="250" height="94" rx="24" fill="rgba(16,185,129,0.14)" stroke="rgba(16,185,129,0.26)" />
      <text x="708" y="426" text-anchor="middle" font-size="${bestPriceSize}" font-weight="800" fill="${p.green}" font-family="Rubik, sans-serif">₪${escapeXml(bestPriceText)}</text>
      ${hasDiscount ? `<text x="708" y="453" text-anchor="middle" font-size="21" font-weight="700" fill="${p.faint}" text-decoration="line-through" font-family="Rubik, sans-serif">₪${escapeXml(compactNumber(bestOffer?.price ?? null))}</text>` : ''}
      <rect x="858" y="366" width="202" height="94" rx="24" fill="${theme === 'light' ? '#ffffff' : 'rgba(255,255,255,0.06)'}" stroke="${p.border}" />
      <clipPath id="bestProductLogo"><rect x="884" y="376" width="74" height="74" rx="20" /></clipPath>
      ${bestOffer?.logoDataUri ? `<image href="${bestOffer.logoDataUri}" x="884" y="376" width="74" height="74" preserveAspectRatio="xMidYMid slice" clip-path="url(#bestProductLogo)" />` : `<rect x="884" y="376" width="74" height="74" rx="20" fill="rgba(99,102,241,0.18)" />`}
      <text x="1040" y="406" text-anchor="end" font-size="19" font-weight="800" fill="${p.text}" font-family="Rubik, sans-serif">${escapeXml(truncate(bestOffer?.chainName || copy.bestDeals, 14))}</text>
      <text x="1040" y="434" text-anchor="end" font-size="15" font-weight="600" fill="${p.muted}" font-family="Rubik, sans-serif">${escapeXml(truncate(city || copy.livePrices, 18))}</text>
    </g>
    ${comparisonDots}
    <rect x="824" y="574" width="264" height="34" rx="17" fill="rgba(99,102,241,0.14)" />
    <text x="956" y="596" text-anchor="middle" font-size="14" font-weight="800" fill="${p.brand}" font-family="Rubik, sans-serif">${escapeXml(copy.openCta)}</text>
  `;

  return renderSocialSvg(socialFrame({ theme, lang, fontCss, logoDataUri, body }));
}

export async function generateShoppingListShareImage(
  listName: string,
  rawItems: unknown,
  theme: ShareTheme,
  lang: ShareLang
): Promise<Buffer> {
  const p = socialPalette(theme);
  const copy = getSocialCopy(lang);
  const { fontCss, logoDataUri } = await socialDefs(theme);
  const itemsArray = Array.isArray(rawItems) ? rawItems as Array<Record<string, unknown>> : [];
  const items = await Promise.all(itemsArray.slice(0, 7).map(async (item): Promise<ShoppingListShareItem> => {
    const productId = String(item.productId || '');
    const mappedItemCode = typeof item.mappedItemCode === 'string' ? item.mappedItemCode : null;
    const name = String(item.nameHe || item.nameEn || item.name || productId || 'פריט');
    return {
      productId,
      mappedItemCode,
      name,
      quantity: Math.max(1, Number(item.quantity || 1)),
      picked: Boolean(item.picked),
      imageDataUri: await catalogOrProductImageDataUri(productId, mappedItemCode),
    };
  }));
  const count = itemsArray.length;
  const title = truncate(listName || copy.listTitle, 34);

  const itemRows = items.slice(0, 5).map((item, index) => {
    const y = 238 + index * 62;
    return `<g>
      <rect x="682" y="${y - 34}" width="404" height="52" rx="16" fill="${theme === 'light' ? '#ffffff' : 'rgba(255,255,255,0.055)'}" stroke="${p.border}" />
      <rect x="1032" y="${y - 27}" width="38" height="38" rx="11" fill="#ffffff" stroke="${p.border}" />
      ${item.imageDataUri
        ? `<image href="${item.imageDataUri}" x="1036" y="${y - 24}" width="30" height="30" preserveAspectRatio="xMidYMid meet" />`
        : `<text x="1051" y="${y}" text-anchor="middle" font-size="18" font-weight="900" fill="${p.brand}" font-family="Rubik, sans-serif">A</text>`}
      <text x="1018" y="${y - 4}" text-anchor="end" font-size="20" font-weight="800" fill="${p.text}" font-family="Rubik, sans-serif">${escapeXml(truncate(item.name, 25))}</text>
      <text x="714" y="${y - 4}" font-size="18" font-weight="900" fill="${p.green}" font-family="Rubik, sans-serif">x${item.quantity}</text>
    </g>`;
  }).join('');

  const heroItems = items.slice(0, 4).map((item, index) => {
    const x = 112 + (index % 2) * 196;
    const y = 238 + Math.floor(index / 2) * 164;
    return `<g filter="url(#softShadow)">
      <rect x="${x}" y="${y}" width="164" height="132" rx="24" fill="${p.card}" stroke="${p.border}" />
      <rect x="${x + 22}" y="${y + 16}" width="120" height="80" rx="18" fill="#ffffff" />
      ${item.imageDataUri ? `<image href="${item.imageDataUri}" x="${x + 32}" y="${y + 22}" width="100" height="68" preserveAspectRatio="xMidYMid meet" />` : `<text x="${x + 82}" y="${y + 72}" text-anchor="middle" font-size="44" font-weight="900" fill="url(#brandGradient)" font-family="Rubik, sans-serif">A</text>`}
      <text x="${x + 82}" y="${y + 116}" text-anchor="middle" font-size="14" font-weight="800" fill="${p.text}" font-family="Rubik, sans-serif">${escapeXml(truncate(item.name, 14))}</text>
    </g>`;
  }).join('');

  const body = `
    <text x="1086" y="170" text-anchor="end" font-size="18" font-weight="800" fill="${p.brand}" font-family="Rubik, sans-serif">${escapeXml(copy.listEyebrow)}</text>
    <text x="1086" y="222" text-anchor="end" font-size="52" font-weight="900" fill="${p.text}" font-family="Rubik, sans-serif">${escapeXml(title)}</text>
    <rect x="844" y="248" width="242" height="42" rx="21" fill="rgba(16,185,129,0.14)" stroke="rgba(16,185,129,0.26)" />
    <text x="965" y="276" text-anchor="middle" font-size="20" font-weight="900" fill="${p.green}" font-family="Rubik, sans-serif">${escapeXml(`${count} ${copy.items}`)}</text>
    ${itemRows}
    <g>
      <rect x="86" y="182" width="500" height="348" rx="34" fill="${theme === 'light' ? 'rgba(255,255,255,0.68)' : 'rgba(255,255,255,0.04)'}" stroke="${p.border}" />
      <text x="336" y="222" text-anchor="middle" font-size="18" font-weight="800" fill="${p.muted}" font-family="Rubik, sans-serif">${escapeXml(copy.livePrices)}</text>
      ${heroItems}
    </g>
    <rect x="820" y="552" width="266" height="32" rx="16" fill="rgba(99,102,241,0.14)" />
    <text x="953" y="573" text-anchor="middle" font-size="14" font-weight="800" fill="${p.brand}" font-family="Rubik, sans-serif">${escapeXml(copy.openCta)}</text>
  `;

  return renderSocialSvg(socialFrame({ theme, lang, fontCss, logoDataUri, body }));
}

export async function generatePromoShareImage(
  prisma: PrismaClient,
  input: SharePromoInput,
  theme: ShareTheme,
  lang: ShareLang
): Promise<Buffer> {
  const promo = await getPromoShareMeta(prisma, input);
  if (!promo) return generateSiteShareImage(theme, lang);

  const p = socialPalette(theme);
  const copy = getSocialCopy(lang);
  const { fontCss, logoDataUri } = await socialDefs(theme);
  const titleLines = splitLinesStrict(promo.itemName, 22, 2);
  const titleSize = fitFontSize(titleLines[0] || promo.itemName, 18, 44, 32);
  const pct = formatPercent(promo.discountPercent);
  const promoSignal = lang === 'he' ? 'מבצע' : lang === 'fr' ? 'PROMO' : 'DEAL';
  const priceText = compactNumber(promo.effectivePrice);
  const promoPriceSize = priceFontSize(promo.effectivePrice, 64, 44);
  const oldPriceText = promo.price !== null ? compactNumber(promo.price) : '';
  const location = truncate(`${promo.storeName}${promo.city ? ` · ${promo.city}` : ''}`, 24);

  const body = `
    <g filter="url(#softShadow)">
      <rect x="72" y="150" width="430" height="382" rx="36" fill="${p.card}" stroke="${p.border}" />
      <rect x="104" y="188" width="366" height="278" rx="30" fill="#ffffff" stroke="${p.border}" />
      ${promo.imageDataUri ? `<image href="${promo.imageDataUri}" x="126" y="210" width="322" height="234" preserveAspectRatio="xMidYMid meet" />` : `<text x="287" y="360" text-anchor="middle" font-size="112" font-weight="800" fill="url(#brandGradient)" font-family="Rubik, sans-serif">A</text>`}
      <rect x="104" y="484" width="366" height="28" rx="14" fill="rgba(239,68,68,0.13)" />
      <text x="287" y="504" text-anchor="middle" font-size="14" font-weight="800" fill="${p.red}" font-family="Rubik, sans-serif">${escapeXml(copy.promoEyebrow)}</text>
      ${pct ? `<rect x="92" y="130" width="132" height="72" rx="30" fill="${p.amber}" /><text x="158" y="177" text-anchor="middle" font-size="34" font-weight="900" fill="#241400" font-family="Rubik, sans-serif">${escapeXml(pct)}</text>` : ''}
    </g>
    <rect x="760" y="128" width="328" height="52" rx="26" fill="rgba(239,68,68,0.16)" stroke="rgba(239,68,68,0.34)" />
    <text x="924" y="162" text-anchor="middle" font-size="24" font-weight="900" fill="${p.red}" font-family="Rubik, sans-serif">${escapeXml(promoSignal)}</text>
    <text x="1088" y="226" text-anchor="end" font-size="${titleSize}" font-weight="800" fill="${p.text}" font-family="Rubik, sans-serif">${escapeXml(titleLines[0] || '')}</text>
    ${titleLines[1] ? `<text x="1088" y="${226 + titleSize + 6}" text-anchor="end" font-size="${titleSize}" font-weight="800" fill="${p.text}" font-family="Rubik, sans-serif">${escapeXml(titleLines[1])}</text>` : ''}
    <text x="1088" y="${titleLines[1] ? 226 + titleSize * 2 + 34 : 226 + titleSize + 34}" text-anchor="end" font-size="20" font-weight="600" fill="${p.muted}" font-family="Rubik, sans-serif">${escapeXml(truncate(promo.manufacturerName || promo.chainName, 30))}</text>
    <g filter="url(#softShadow)">
      <rect x="560" y="354" width="528" height="176" rx="34" fill="${p.card}" stroke="${p.border}" />
      <rect x="584" y="380" width="278" height="124" rx="28" fill="rgba(16,185,129,0.14)" stroke="rgba(16,185,129,0.28)" />
      <text x="723" y="454" text-anchor="middle" font-size="${promoPriceSize}" font-weight="800" fill="${p.green}" font-family="Rubik, sans-serif">₪${escapeXml(priceText)}</text>
      ${oldPriceText ? `<text x="723" y="488" text-anchor="middle" font-size="24" font-weight="700" fill="${p.faint}" text-decoration="line-through" font-family="Rubik, sans-serif">₪${escapeXml(oldPriceText)}</text>` : ''}
      <rect x="892" y="378" width="168" height="126" rx="28" fill="${theme === 'light' ? '#ffffff' : 'rgba(255,255,255,0.06)'}" stroke="${p.border}" />
      <clipPath id="promoLogo"><rect x="936" y="392" width="80" height="80" rx="22" /></clipPath>
      ${promo.logoDataUri ? `<image href="${promo.logoDataUri}" x="936" y="392" width="80" height="80" preserveAspectRatio="xMidYMid slice" clip-path="url(#promoLogo)" />` : `<rect x="936" y="392" width="80" height="80" rx="22" fill="rgba(99,102,241,0.16)" />`}
      <text x="976" y="494" text-anchor="middle" font-size="17" font-weight="800" fill="${p.text}" font-family="Rubik, sans-serif">${escapeXml(truncate(promo.chainName, 14))}</text>
      <text x="976" y="516" text-anchor="middle" font-size="12" font-weight="600" fill="${p.muted}" font-family="Rubik, sans-serif">${escapeXml(location)}</text>
    </g>
    <rect x="824" y="574" width="264" height="34" rx="17" fill="rgba(99,102,241,0.14)" />
    <text x="956" y="596" text-anchor="middle" font-size="14" font-weight="800" fill="${p.brand}" font-family="Rubik, sans-serif">${escapeXml(copy.openCta)}</text>
  `;

  return renderSocialSvg(socialFrame({ theme, lang, fontCss, logoDataUri, body }));
}

export async function generatePromotionsShareImage(
  prisma: PrismaClient,
  input: SharePromotionScopeInput,
  theme: ShareTheme,
  lang: ShareLang
): Promise<Buffer> {
  const p = socialPalette(theme);
  const copy = getSocialCopy(lang);
  const { fontCss, logoDataUri } = await socialDefs(theme);
  const meta = await getPromotionsShareMeta(prisma, input);
  const titleLines = splitLines(meta.title || copy.bestDeals, 26, 2);

  const cards = meta.promotions.slice(0, 5).map((promo, index) => {
    const x = 92 + index * 206;
    const y = index % 2 === 0 ? 326 : 354;
    const pct = formatPercent(promo.discountPercent);
    return `<g filter="url(#softShadow)">
      <rect x="${x}" y="${y}" width="178" height="180" rx="26" fill="${p.card}" stroke="${p.border}" />
      <rect x="${x + 18}" y="${y + 16}" width="142" height="92" rx="20" fill="#ffffff" />
      ${promo.imageDataUri ? `<image href="${promo.imageDataUri}" x="${x + 28}" y="${y + 22}" width="122" height="80" preserveAspectRatio="xMidYMid meet" />` : `<text x="${x + 89}" y="${y + 80}" text-anchor="middle" font-size="46" font-weight="900" fill="url(#brandGradient)" font-family="Rubik, sans-serif">A</text>`}
      ${pct ? `<rect x="${x + 18}" y="${y + 18}" width="62" height="26" rx="13" fill="${p.amber}" /><text x="${x + 49}" y="${y + 37}" text-anchor="middle" font-size="15" font-weight="900" fill="#241400" font-family="Rubik, sans-serif">${escapeXml(pct)}</text>` : ''}
      <text x="${x + 160}" y="${y + 134}" text-anchor="end" font-size="14" font-weight="900" fill="${p.text}" font-family="Rubik, sans-serif">${escapeXml(truncate(promo.itemName, 17))}</text>
      <text x="${x + 160}" y="${y + 162}" text-anchor="end" font-size="30" font-weight="900" fill="${p.green}" font-family="Rubik, sans-serif">₪${escapeXml(compactNumber(promo.effectivePrice))}</text>
    </g>`;
  }).join('');

  const body = `
    <text x="1088" y="166" text-anchor="end" font-size="18" font-weight="800" fill="${p.brand}" font-family="Rubik, sans-serif">${escapeXml(copy.promosEyebrow)}</text>
    <text x="1088" y="222" text-anchor="end" font-size="54" font-weight="900" fill="${p.text}" font-family="Rubik, sans-serif">${escapeXml(titleLines[0] || '')}</text>
    ${titleLines[1] ? `<text x="1088" y="280" text-anchor="end" font-size="54" font-weight="900" fill="${p.text}" font-family="Rubik, sans-serif">${escapeXml(titleLines[1])}</text>` : ''}
    <text x="1088" y="${titleLines[1] ? 318 : 280}" text-anchor="end" font-size="23" font-weight="700" fill="${p.muted}" font-family="Rubik, sans-serif">${escapeXml(copy.livePrices)}</text>
    <rect x="88" y="186" width="408" height="98" rx="28" fill="${p.card}" stroke="${p.border}" filter="url(#softShadow)" />
    <text x="292" y="226" text-anchor="middle" font-size="18" font-weight="800" fill="${p.muted}" font-family="Rubik, sans-serif">${escapeXml(copy.bestDeals)}</text>
    <text x="292" y="264" text-anchor="middle" font-size="38" font-weight="900" fill="url(#brandGradient)" font-family="Rubik, sans-serif">${meta.promotions.length || 0} ${escapeXml(copy.items)}</text>
    ${cards}
    <rect x="818" y="552" width="270" height="32" rx="16" fill="rgba(99,102,241,0.14)" />
    <text x="953" y="573" text-anchor="middle" font-size="14" font-weight="800" fill="${p.brand}" font-family="Rubik, sans-serif">${escapeXml(copy.openCta)}</text>
  `;

  return renderSocialSvg(socialFrame({ theme, lang, fontCss, logoDataUri, body }));
}

export async function generateSiteShareImage(theme: ShareTheme, lang: ShareLang): Promise<Buffer> {
  const p = socialPalette(theme);
  const copy = getSocialCopy(lang);
  const { fontCss, logoDataUri } = await socialDefs(theme);
  const [osherLogoDataUri, ramiLogoDataUri, yeshLogoDataUri] = await Promise.all([
    chainLogoDataUri('אושר עד', '7290103152017'),
    chainLogoDataUri('רמי לוי שיווק השקמה', '7290058140886'),
    chainLogoDataUri('יש חסד'),
  ]);
  const body = `
    <text x="1088" y="182" text-anchor="end" font-size="86" font-weight="900" fill="url(#brandGradient)" font-family="Rubik, sans-serif">${escapeXml(copy.siteTitle)}</text>
    ${svgTextLines(splitLines(copy.siteSubtitle, 34, 2), {
      x: 1088,
      y: 244,
      lineHeight: 34,
      size: 26,
      weight: 700,
      fill: p.text,
      anchor: 'end',
    })}
    <g filter="url(#softShadow)">
      <rect x="92" y="176" width="430" height="336" rx="34" fill="${p.card}" stroke="${p.border}" />
      <rect x="124" y="212" width="368" height="180" rx="42" fill="${theme === 'light' ? '#f7f8ff' : 'rgba(255,255,255,0.055)'}" stroke="${p.border}" />
      <path d="M170 304 C218 246 396 246 444 304" fill="none" stroke="rgba(99,102,241,0.22)" stroke-width="4" stroke-linecap="round" />
      <clipPath id="siteChainLogoSide1"><rect x="136" y="258" width="100" height="100" rx="28" /></clipPath>
      <clipPath id="siteChainLogoSide2"><rect x="378" y="258" width="100" height="100" rx="28" /></clipPath>
      <clipPath id="siteChainLogoMain"><rect x="239" y="236" width="136" height="136" rx="34" /></clipPath>
      <rect x="136" y="258" width="100" height="100" rx="28" fill="#ffffff" stroke="${p.border}" opacity="0.9" />
      ${osherLogoDataUri ? `<image href="${osherLogoDataUri}" x="136" y="258" width="100" height="100" preserveAspectRatio="xMidYMid slice" clip-path="url(#siteChainLogoSide1)" opacity="0.96" />` : ''}
      <rect x="378" y="258" width="100" height="100" rx="28" fill="#ffffff" stroke="${p.border}" opacity="0.9" />
      ${yeshLogoDataUri ? `<image href="${yeshLogoDataUri}" x="378" y="258" width="100" height="100" preserveAspectRatio="xMidYMid slice" clip-path="url(#siteChainLogoSide2)" opacity="0.96" />` : ''}
      <rect x="239" y="236" width="136" height="136" rx="34" fill="#ffffff" stroke="rgba(255,255,255,0.55)" />
      ${ramiLogoDataUri ? `<image href="${ramiLogoDataUri}" x="239" y="236" width="136" height="136" preserveAspectRatio="xMidYMid slice" clip-path="url(#siteChainLogoMain)" />` : `<text x="307" y="322" text-anchor="middle" font-size="68" font-weight="900" fill="url(#brandGradient)" font-family="Rubik, sans-serif">A</text>`}
      <circle cx="276" cy="420" r="6" fill="${p.brand}" />
      <circle cx="307" cy="420" r="6" fill="${p.green}" />
      <circle cx="338" cy="420" r="6" fill="${p.pink}" />
      <text x="205" y="468" text-anchor="middle" font-size="48" font-weight="900" fill="${p.text}" font-family="Rubik, sans-serif">${escapeXml(copy.chainCountNumber)}</text>
      <text x="382" y="466" text-anchor="middle" font-size="27" font-weight="900" fill="${p.text}" font-family="Rubik, sans-serif">${escapeXml(copy.chainCountLabel)}</text>
    </g>
    <g>
      <rect x="650" y="382" width="438" height="54" rx="27" fill="rgba(99,102,241,0.14)" stroke="rgba(99,102,241,0.22)" />
      <text x="869" y="417" text-anchor="middle" font-size="21" font-weight="900" fill="${p.brand}" font-family="Rubik, sans-serif">${escapeXml(copy.livePrices)}</text>
      <rect x="730" y="454" width="358" height="54" rx="27" fill="rgba(16,185,129,0.14)" stroke="rgba(16,185,129,0.22)" />
      <text x="909" y="489" text-anchor="middle" font-size="21" font-weight="900" fill="${p.green}" font-family="Rubik, sans-serif">${escapeXml(copy.openCta)}</text>
    </g>
  `;

  return renderSocialSvg(socialFrame({ theme, lang, fontCss, logoDataUri, body }));
}
