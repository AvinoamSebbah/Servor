import { Router } from 'express';
import axios from 'axios';
import https from 'https';

const router = Router();
const GOOGLE_TRANSLATE_API = 'https://translation.googleapis.com/language/translate/v2';
const TRANSLATION_CACHE_MAX = 1000;
const translationCache = new Map<string, TranslationResponse>();

type TranslationResponse = {
  translatedText: string;
  detectedSourceLanguage?: string;
  cached?: boolean;
};

function getCacheKey(q: string, source: string, target: string) {
  return JSON.stringify({
    q: q.trim(),
    source: source.trim().toLowerCase() || 'auto',
    target: target.trim().toLowerCase(),
  });
}

router.post('/', async (req, res) => {
  const { q, source = 'auto', target = 'he' } = req.body as {
    q?: unknown;
    source?: string;
    target?: string;
  };

  if (typeof q !== 'string' || !q.trim()) {
    return res.status(400).json({ error: 'q is required' });
  }
  if (q.length > 500) {
    return res.status(400).json({ error: 'Query too long (max 500 characters)' });
  }

  const apiKey = process.env.GOOGLE_TRANSLATE_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Translation service unavailable' });
  }

  // TLS verification always enforced — do not disable via env var
  const googleTranslateHttpsAgent = new https.Agent({ rejectUnauthorized: true });

  const normalizedQuery = q.trim();
  const normalizedSource = typeof source === 'string' ? source : 'auto';
  const normalizedTarget = typeof target === 'string' && target.trim() ? target.trim() : 'he';
  const cacheKey = getCacheKey(normalizedQuery, normalizedSource, normalizedTarget);
  const cachedTranslation = translationCache.get(cacheKey);

  if (cachedTranslation) {
    return res.json({ ...cachedTranslation, cached: true });
  }

  try {
    const { data } = await axios.post(
      GOOGLE_TRANSLATE_API,
      {
        q: normalizedQuery,
        target: normalizedTarget,
        format: 'text',
        ...(normalizedSource !== 'auto' ? { source: normalizedSource } : {}),
      },
      {
        headers: { 'Content-Type': 'application/json' },
        params: { key: apiKey },
        timeout: 5000,
        httpsAgent: googleTranslateHttpsAgent,
      },
    );

    const translation = data?.data?.translations?.[0];
    const translatedText = translation?.translatedText;

    if (typeof translatedText !== 'string' || !translatedText.trim()) {
      return res.status(502).json({ error: 'Invalid translation response' });
    }

    const responseBody: TranslationResponse = {
      translatedText: translatedText.trim(),
      detectedSourceLanguage: typeof translation?.detectedSourceLanguage === 'string'
        ? translation.detectedSourceLanguage
        : undefined,
    };

    translationCache.set(cacheKey, responseBody);
    // Evict oldest entries if cache exceeds max size
    if (translationCache.size > TRANSLATION_CACHE_MAX) {
      const firstKey = translationCache.keys().next().value;
      if (firstKey !== undefined) translationCache.delete(firstKey);
    }

    return res.json({ ...responseBody, cached: false });
  } catch (err: any) {
    const status = err?.response?.status;
    if (status) {
      return res.status(502).json({ error: 'Translation service error', status });
    }
    return res.status(502).json({ error: 'Translation service unreachable' });
  }
});

export default router;
