import fs from 'fs/promises';
import https from 'https';
import path from 'path';
import { Prisma, PrismaClient } from '@prisma/client';
import { Resvg } from '@resvg/resvg-js';
import axios from 'axios';
import sharp from 'sharp';

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

export const SHARE_IMAGE_WIDTH = 1200;
export const SHARE_IMAGE_HEIGHT = 780;

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
    const buffer = Buffer.from(response.data);
    const type = detectContentType(buffer, typeHeader.split(';')[0]);
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
  const cssUrl = 'https://fonts.googleapis.com/css2?family=Rubik:wght@400;500;700;800;900&family=Space+Grotesk:wght@500;700&display=swap';
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

export async function generateProductShareImage(
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
  const logoDataUri = await fetchDataUri(`${PUBLIC_FRONTEND_BASE_URL}/logo.png`);
  const productImageCandidates = [
    `https://m.pricez.co.il/ProductPictures/200x/${encodeURIComponent(barcode)}.jpg`,
    `https://res.cloudinary.com/dprve5nst/image/upload/w_360,h_360,c_pad,b_white/products/${encodeURIComponent(barcode)}.jpg`,
  ];
  let productImageDataUri: string | null = null;
  for (const url of productImageCandidates) {
    productImageDataUri = await fetchDataUri(url);
    if (productImageDataUri) break;
  }
  const productLines = splitLines(meta.itemName, 30, 2);
  const manufacturer = truncate(meta.manufacturerName || copy.compare, 34);
  const safeCity = truncate(city || 'תל אביב', 18);
  const titleX = isRtl ? 704 : 84;
  const titleAnchor = isRtl ? 'end' : 'start';
  const cityLabelX = isRtl ? 918 : 904;
  const cityValueX = isRtl ? 1100 : 936;
  const cityValueAnchor = isRtl ? 'end' : 'start';
  const heroCardY = 156;
  const heroCardHeight = 212;
  const titleCardX = 56;
  const titleCardWidth = 676;
  const imageCardX = 804;
  const imageCardWidth = 262;
  const gridStartX = 48;
  const gridStartY = 412;
  const cardGapX = 24;
  const cardGapY = 20;
  const cardWidth = 540;
  const cardHeight = 118;

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
    const nameLines = splitLinesNoEllipsis(offer.chainName, isRtl ? 11 : 13, 2).map(escapeXml);
     const contentLeft = x + 24;
     const contentRight = x + cardWidth - 24;
    const logoCardWidth = 96;
    const logoCardHeight = 76;
     const logoCardX = isRtl ? contentRight - logoCardWidth : contentLeft;
    const logoImageX = logoCardX;
    const logoImageY = y + 16;
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
      ? `<text x="${priceX}" y="${y + 34}" text-anchor="${priceAnchor}" font-size="16" font-weight="600" fill="${palette.strike}" text-decoration="line-through" font-family="Rubik, sans-serif">${escapeXml(formatPrice(offer.price))}</text>
        <text x="${priceX}" y="${y + 82}" text-anchor="${priceAnchor}" font-size="40" font-weight="800" fill="${palette.promo}" font-family="Rubik, sans-serif">${escapeXml(formatPrice(offer.effectivePrice))}</text>`
      : `<text x="${priceX}" y="${y + 74}" text-anchor="${priceAnchor}" font-size="40" font-weight="800" fill="${palette.promo}" font-family="Rubik, sans-serif">${escapeXml(formatPrice(offer.effectivePrice ?? offer.price))}</text>`;
    const logoMarkup = offer.logoDataUri
      ? `<clipPath id="logoCardClip${index}">
          <rect x="${logoCardX}" y="${y + 16}" width="${logoCardWidth}" height="${logoCardHeight}" rx="18" ry="18" />
        </clipPath>
        <image href="${offer.logoDataUri}" x="${logoImageX}" y="${logoImageY}" width="${logoImageWidth}" height="${logoImageHeight}" preserveAspectRatio="xMidYMid slice" clip-path="url(#logoCardClip${index})" />`
      : `<rect x="${logoCardX}" y="${y + 16}" width="${logoCardWidth}" height="${logoCardHeight}" rx="18" fill="${palette.accentSoft}" stroke="${palette.panelBorder}" />
        <text x="${logoCardX + logoCardWidth / 2}" y="${y + 62}" text-anchor="middle" font-size="24" font-weight="800" fill="${palette.accent}" font-family="Rubik, sans-serif">${escapeXml((offer.chainName || offer.storeName || '?').slice(0, 1))}</text>`;

    return `
      <rect x="${x}" y="${y}" width="${cardWidth}" height="${cardHeight}" rx="24" fill="${palette.panel}" stroke="${palette.line}" />
      ${logoMarkup}
      <text x="${nameX}" y="${nameLines.length > 1 ? y + 60 : y + 70}" text-anchor="${nameAnchor}" font-size="22" font-weight="700" fill="${palette.text}" font-family="Rubik, sans-serif">${nameLines[0] || ''}</text>
      ${nameLines[1] ? `<text x="${nameX}" y="${y + 88}" text-anchor="${nameAnchor}" font-size="22" font-weight="700" fill="${palette.text}" font-family="Rubik, sans-serif">${nameLines[1]}</text>` : ''}
      ${promoBadge}
      ${priceBlock}
    `;
  }).join('');

  const productImageMarkup = productImageDataUri
     ? `<image href="${productImageDataUri}" x="${imageCardX}" y="${heroCardY}" width="${imageCardWidth}" height="${heroCardHeight}" preserveAspectRatio="xMidYMid meet" clip-path="url(#productImageClip)" />`
     : `<rect x="${imageCardX}" y="${heroCardY}" width="${imageCardWidth}" height="${heroCardHeight}" rx="32" fill="${palette.accentSoft}" />
       <text x="${imageCardX + imageCardWidth / 2}" y="${heroCardY + 122}" text-anchor="middle" font-size="72" font-weight="700" fill="${palette.accent}" font-family="'Space Grotesk', sans-serif">A</text>`;

  const svg = `
  <svg width="${SHARE_IMAGE_WIDTH}" height="${SHARE_IMAGE_HEIGHT}" viewBox="0 0 ${SHARE_IMAGE_WIDTH} ${SHARE_IMAGE_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="${SHARE_IMAGE_WIDTH}" y2="${SHARE_IMAGE_HEIGHT}" gradientUnits="userSpaceOnUse">
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
    <rect width="${SHARE_IMAGE_WIDTH}" height="${SHARE_IMAGE_HEIGHT}" fill="url(#bg)" />
    <circle cx="1090" cy="120" r="180" fill="${palette.accentSoft}" />
    <circle cx="138" cy="710" r="190" fill="${palette.accentSoft}" />

    <rect x="40" y="34" width="1120" height="712" rx="38" fill="transparent" stroke="${palette.line}" />

    <g>
      <rect x="56" y="50" width="1088" height="80" rx="28" fill="${palette.panel}" stroke="${palette.panelBorder}" />
      ${logoDataUri ? `<image href="${logoDataUri}" x="82" y="66" width="48" height="48" preserveAspectRatio="xMidYMid meet" />` : `<rect x="82" y="66" width="48" height="48" rx="14" fill="${palette.accentSoft}" />`}
      <text x="144" y="94" font-size="31" font-weight="800" fill="${palette.text}" font-family="'Space Grotesk', Rubik, sans-serif">AGALI</text>
      <text x="144" y="116" font-size="14" font-weight="600" fill="${palette.muted}" font-family="Rubik, sans-serif">${escapeXml(copy.compare)}</text>
      <rect x="894" y="68" width="232" height="44" rx="22" fill="${palette.accentSoft}" stroke="${palette.panelBorder}" />
      <text x="${cityLabelX}" y="96" font-size="16" font-weight="700" fill="${palette.accent}" font-family="Rubik, sans-serif">${escapeXml(copy.byCity)}</text>
      <text x="${cityValueX}" y="96" text-anchor="${cityValueAnchor}" font-size="18" font-weight="700" fill="${palette.text}" font-family="Rubik, sans-serif">${escapeXml(safeCity)}</text>
    </g>

    <g filter="url(#shadow)">
      <rect x="${titleCardX}" y="${heroCardY}" width="${titleCardWidth}" height="${heroCardHeight}" rx="32" fill="${palette.panel}" stroke="${palette.panelBorder}" />
      <text x="${titleX}" y="210" text-anchor="${titleAnchor}" font-size="17" font-weight="700" fill="${palette.accent}" font-family="Rubik, sans-serif">${escapeXml(copy.bestOffers)}</text>
      <text x="${titleX}" y="260" text-anchor="${titleAnchor}" font-size="38" font-weight="800" fill="${palette.text}" font-family="Rubik, sans-serif">${escapeXml(productLines[0] || '')}</text>
      ${productLines[1] ? `<text x="${titleX}" y="304" text-anchor="${titleAnchor}" font-size="38" font-weight="800" fill="${palette.text}" font-family="Rubik, sans-serif">${escapeXml(productLines[1])}</text>` : ''}
      <text x="${titleX}" y="346" text-anchor="${titleAnchor}" font-size="24" font-weight="600" fill="${palette.muted}" font-family="Rubik, sans-serif">${escapeXml(manufacturer)}</text>

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