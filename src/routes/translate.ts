import { Router } from 'express';
import axios from 'axios';
import https from 'https';

const router = Router();

const TRANSLATE_API = 'https://translate.agali.live/translate';

// Agent that skips certificate revocation check (needed on some Windows environments)
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

router.post('/', async (req, res) => {
  const { q, source = 'auto', target = 'he' } = req.body as {
    q?: unknown;
    source?: string;
    target?: string;
  };

  if (typeof q !== 'string' || !q.trim()) {
    return res.status(400).json({ error: 'q is required' });
  }

  try {
    const { data } = await axios.post(
      TRANSLATE_API,
      { q: q.trim(), source, target, format: 'text', api_key: '' },
      { headers: { 'Content-Type': 'application/json' }, timeout: 5000, httpsAgent },
    );
    return res.json(data);
  } catch (err: any) {
    const status = err?.response?.status;
    if (status) {
      return res.status(502).json({ error: 'Translation service error', status });
    }
    return res.status(502).json({ error: 'Translation service unreachable', detail: String(err?.message ?? err) });
  }
});

export default router;
