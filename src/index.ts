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

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// ─── CORS: set headers on EVERY response, before all other middleware ─────────
// This ensures CORS headers are present even on error responses (403, 500, etc.)
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Requested-With');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// CORS — allow Vercel frontend + local dev
app.use(cors({
  origin: true,
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static images
app.use('/images', express.static(path.join(__dirname, '../public/images')));

// Session
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'your-secret-key-change-this',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
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
app.use('/share', shareRouter);
app.use('/api/translate', translateRouter);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

const HOST = '0.0.0.0'; // Autorise les connexions externes (Docker/Caddy)

app.listen(Number(PORT), HOST, () => {
  console.log(`🚀 Server running on http://${HOST}:${PORT}`);
});
