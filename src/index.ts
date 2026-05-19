import express from 'express';
import cors from 'cors';
import session from 'express-session';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import path from 'path';
import productsRouter from './routes/products';
import authRouter from './routes/auth';
import userRouter from './routes/user';
import imagesRouter from './routes/images';
import storesRouter from './routes/stores';
import compareRouter from './routes/compare';
import scanRouter from './routes/scan';
import offersRouter from './routes/offers';
import shoppingListsRouter from './routes/shoppingLists';
import shareRouter from './routes/share';
import shortLinksRouter from './routes/shortLinks';
import translateRouter from './routes/translate';
import observationsRouter from './routes/observations';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;
const DEFAULT_ALLOWED_ORIGINS = [
  'https://agali.live',
  'https://www.agali.live',
  'https://api.agali.live',
];
const allowedOrigins = [
  ...DEFAULT_ALLOWED_ORIGINS,
  ...(process.env.CORS_ALLOWED_ORIGINS || process.env.FRONTEND_URL || '')
  .split(',')
  .map((origin) => origin.trim())
    .filter(Boolean),
];

function isAllowedOrigin(origin: string) {
  if (allowedOrigins.includes(origin)) {
    return true;
  }

  if (process.env.NODE_ENV !== 'production') {
    return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  }

  return false;
}

// ── Security: crash if SESSION_SECRET missing ───────────────────────────────
const sessionSecret = process.env.SESSION_SECRET || process.env.NEXTAUTH_SECRET;
if (!sessionSecret) {
  console.error('FATAL: SESSION_SECRET environment variable is not set. Refusing to start.');
  process.exit(1);
}
if (!process.env.BACKEND_BASE_URL && process.env.NODE_ENV === 'production') {
  console.warn('WARNING: BACKEND_BASE_URL is not set. Share routes will fall back to X-Forwarded-Host header (SSRF risk). Set BACKEND_BASE_URL in production.');
}

// ── Security headers (helmet) + X-Powered-By ─────────────────────────────────
app.disable('x-powered-by');
app.use(helmet({
  // The API is on api.agali.live and assets/images are consumed from the
  // www.agali.live / agali.live frontend (and from imgproxy redirects).
  // Helmet's default `same-origin` CORP breaks cross-origin <img> loads with
  // ERR_BLOCKED_BY_RESPONSE.NotSameOrigin, so widen to cross-origin.
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'none'"],      // share.ts/shortLinks.ts override per-response with nonce
      scriptSrcAttr: ["'none'"],
      styleSrc: ["'self'", 'https:', "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      fontSrc: ["'self'", 'https:', 'data:'],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
}));

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use(cors({
  origin(origin, callback) {
    // In production: reject requests with no Origin header (prevents server-side abuse)
    if (!origin) {
      if (process.env.NODE_ENV !== 'production') {
        callback(null, true);
      } else {
        callback(null, false);
      }
      return;
    }

    if (isAllowedOrigin(origin)) {
      callback(null, true);
      return;
    }

    callback(null, false);
  },
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ── X-API-Key middleware (protects all routes except share/shortlinks) ─────────
const API_SECRET_KEY = process.env.API_SECRET_KEY;
if (!API_SECRET_KEY && process.env.NODE_ENV === 'production') {
  console.warn('WARNING: API_SECRET_KEY is not set. Public endpoints are unprotected.');
}
const BYPASS_API_KEY_RE = /^\/(share\/|s\/|health$)/;
app.use((req, res, next) => {
  if (!API_SECRET_KEY) return next(); // key not configured — skip check (dev mode)
  if (BYPASS_API_KEY_RE.test(req.path)) return next(); // OG/share routes accessible by crawlers
  const clientKey = req.headers['x-api-key'];
  if (clientKey !== API_SECRET_KEY) return res.status(403).json({ error: 'Forbidden' });
  next();
});
app.use('/images', express.static(path.join(__dirname, '../public/images')));

// ── Rate limiters ─────────────────────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});
const authStrictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts, please try again later.' },
});
const translateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Translation quota exceeded, try again later.' },
});
const scanLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Scan quota exceeded, try again later.' },
});

// Session
app.use(
  session({
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      sameSite: 'strict',
      maxAge: 2 * 60 * 60 * 1000, // 2 hours
    },
  })
);

// Routes
app.use('/api/products', imagesRouter); // Doit être avant productsRouter !
app.use('/api/products', productsRouter);
app.use('/api/stores', storesRouter);
app.use('/api/compare', compareRouter);
app.use('/api/scan', scanLimiter, scanRouter);
app.use('/api/offers', offersRouter);
app.use('/api/lists', shoppingListsRouter);
app.use('/api/auth', authLimiter, authRouter);
app.use('/api/user', userRouter);
app.use('/api/observations', observationsRouter);
app.use(shortLinksRouter);
app.use('/share', shareRouter);
app.use('/translate', translateLimiter, translateRouter);
app.use('/api/translate', translateLimiter, translateRouter);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

const HOST = '0.0.0.0'; // Autorise les connexions externes (Docker/Caddy)

app.listen(Number(PORT), HOST, () => {
  console.log(`🚀 Server running on http://${HOST}:${PORT}`);
});
