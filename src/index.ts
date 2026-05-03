import express from 'express';
import cors from 'cors';
import session from 'express-session';
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
import translateRouter from './routes/translate';
import observationsRouter from './routes/observations';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;
const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS || process.env.FRONTEND_URL || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

function isAllowedOrigin(origin: string) {
  if (allowedOrigins.includes(origin)) {
    return true;
  }

  if (process.env.NODE_ENV !== 'production') {
    return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  }

  return false;
}

app.use(cors({
  origin(origin, callback) {
    if (!origin) {
      callback(null, true);
      return;
    }

    if (isAllowedOrigin(origin)) {
      callback(null, true);
      return;
    }

    callback(new Error('CORS origin not allowed'));
  },
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static images
app.use('/images', express.static(path.join(__dirname, '../public/images')));

// Session
app.use(
  session({
    secret: process.env.SESSION_SECRET || process.env.NEXTAUTH_SECRET || 'your-secret-key-change-this',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    },
  })
);

// Routes
app.use('/api/products', imagesRouter); // Doit être avant productsRouter !
app.use('/api/products', productsRouter);
app.use('/api/stores', storesRouter);
app.use('/api/compare', compareRouter);
app.use('/api/scan', scanRouter);
app.use('/api/offers', offersRouter);
app.use('/api/lists', shoppingListsRouter);
app.use('/api/auth', authRouter);
app.use('/api/user', userRouter);
app.use('/api/observations', observationsRouter);
app.use('/share', shareRouter);
app.use('/translate', translateRouter);
app.use('/api/translate', translateRouter);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

const HOST = '0.0.0.0'; // Autorise les connexions externes (Docker/Caddy)

app.listen(Number(PORT), HOST, () => {
  console.log(`🚀 Server running on http://${HOST}:${PORT}`);
});
