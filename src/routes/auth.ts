import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';

const router = Router();
const prisma = new PrismaClient();

// ── Helpers ────────────────────────────────────────────────────────────────────

const SALT_ROUNDS = 12;
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function generateToken(): string {
  return crypto.randomBytes(48).toString('hex');
}

function generateCuid(): string {
  // Simple CUID-like unique ID using crypto
  const timestamp = Date.now().toString(36);
  const random = crypto.randomBytes(12).toString('hex');
  return `c${timestamp}${random}`;
}

function sanitizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function validatePassword(password: string): { valid: boolean; message?: string } {
  if (password.length < 8) return { valid: false, message: 'Password too short (min 8 chars)' };
  if (!/[A-Z]/.test(password)) return { valid: false, message: 'Password must contain uppercase letter' };
  if (!/[0-9]/.test(password)) return { valid: false, message: 'Password must contain a digit' };
  return { valid: true };
}

async function createAuthToken(userId: string, req: Request): Promise<string> {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

  await prisma.$executeRawUnsafe(
    `INSERT INTO auth_tokens (user_id, token, expires_at, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5)`,
    userId,
    token,
    expiresAt,
    req.ip || null,
    req.headers['user-agent'] || null
  );

  return token;
}

async function getUserByToken(token: string) {
  if (!token) return null;
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT u.*, at.expires_at
     FROM auth_tokens at
     JOIN users u ON u.id = at.user_id
     WHERE at.token = $1 AND at.expires_at > NOW()`,
    token
  );
  return rows[0] || null;
}

function safeUser(user: any) {
  if (!user) return null;
  const { password_hash, ...safe } = user;
  void password_hash;
  return safe;
}

// ── GET /api/auth/check-user?email=... ───────────────────────────────────────
// Returns { exists: true/false } — used by frontend to adapt UX (no PW strength bar for existing users)

router.get('/check-user', async (req: Request, res: Response) => {
  try {
    const raw = (req.query.email as string) || '';
    if (!raw) return res.json({ exists: false });
    const cleanEmail = sanitizeEmail(raw);
    const rows = await prisma.$queryRawUnsafe<any[]>(
      'SELECT id FROM users WHERE email = $1',
      cleanEmail
    );
    return res.json({ exists: rows.length > 0 });
  } catch {
    return res.json({ exists: false });
  }
});

// ── POST /api/auth/signup ─────────────────────────────────────────────────────

router.post('/signup', async (req: Request, res: Response) => {
  try {
    const { email, password, name, age, plan } = req.body;

    // Validation
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const cleanEmail = sanitizeEmail(email);
    const { valid, message } = validatePassword(password);
    if (!valid) return res.status(400).json({ error: message });

    // Check existing user
    const existing = await prisma.$queryRawUnsafe<any[]>(
      'SELECT id FROM users WHERE email = $1',
      cleanEmail
    );
    if (existing.length > 0) {
      return res.status(409).json({ error: 'Email already registered', code: 'EMAIL_EXISTS' });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    // Create user
    const userId = generateCuid();
    const cleanPlan = ['free', 'pro', 'max'].includes(plan) ? plan : 'free';
    const cleanAge = age ? Math.max(1, Math.min(120, parseInt(age, 10))) : null;
    const displayName = name?.trim() || cleanEmail.split('@')[0];

    await prisma.$executeRawUnsafe(
      `INSERT INTO users (id, email, password_hash, name, display_name, age, plan, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())`,
      userId,
      cleanEmail,
      passwordHash,
      displayName,
      displayName,
      cleanAge,
      cleanPlan
    );

    // Create token
    const token = await createAuthToken(userId, req);

    const users = await prisma.$queryRawUnsafe<any[]>('SELECT * FROM users WHERE id = $1', userId);
    const user = users[0];

    return res.status(201).json({
      success: true,
      token,
      user: safeUser(user),
    });
  } catch (error) {
    console.error('Signup error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/auth/signin ─────────────────────────────────────────────────────

router.post('/signin', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const cleanEmail = sanitizeEmail(email);

    // Find user
    const users = await prisma.$queryRawUnsafe<any[]>(
      'SELECT * FROM users WHERE email = $1',
      cleanEmail
    );

    if (!users.length) {
      // Timing-safe: still hash (prevents timing attack)
      await bcrypt.hash(password, SALT_ROUNDS);
      return res.status(401).json({ error: 'Invalid credentials', code: 'INVALID_CREDENTIALS' });
    }

    const user = users[0];

    // Verify password
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return res.status(401).json({ error: 'Invalid credentials', code: 'INVALID_CREDENTIALS' });
    }

    // Issue token
    const token = await createAuthToken(user.id, req);

    // Clean old expired tokens for this user (housekeeping)
    await prisma.$executeRawUnsafe(
      'DELETE FROM auth_tokens WHERE user_id = $1 AND expires_at < NOW()',
      user.id
    );

    return res.json({
      success: true,
      token,
      user: safeUser(user),
    });
  } catch (error) {
    console.error('Signin error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/auth/signout ────────────────────────────────────────────────────

router.post('/signout', async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.replace('Bearer ', '').trim();

    if (token) {
      await prisma.$executeRawUnsafe('DELETE FROM auth_tokens WHERE token = $1', token);
    }

    // Also destroy express session if any
    req.session?.destroy?.(() => {});

    return res.json({ success: true });
  } catch (error) {
    console.error('Signout error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/auth/session ─────────────────────────────────────────────────────

router.get('/session', async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.replace('Bearer ', '').trim();

    if (!token) {
      return res.json({ user: null });
    }

    const user = await getUserByToken(token);
    if (!user) {
      return res.json({ user: null });
    }

    return res.json({ user: safeUser(user) });
  } catch (error) {
    console.error('Session error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── PUT /api/auth/profile ─────────────────────────────────────────────────────

router.put('/profile', async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.replace('Bearer ', '').trim();
    if (!token) return res.status(401).json({ error: 'Unauthorized' });

    const user = await getUserByToken(token);
    if (!user) return res.status(401).json({ error: 'Invalid or expired session' });

    const { name, age, city, plan } = req.body;
    const updates: string[] = [];
    const values: any[] = [];
    let idx = 1;

    if (name !== undefined) { updates.push(`display_name = $${idx++}`); values.push(name.trim()); }
    if (age !== undefined) { updates.push(`age = $${idx++}`); values.push(parseInt(age, 10)); }
    if (city !== undefined) { updates.push(`city = $${idx++}`); values.push(city); }
    if (plan !== undefined && ['free', 'pro', 'max'].includes(plan)) {
      updates.push(`plan = $${idx++}`); values.push(plan);
    }

    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

    updates.push(`updated_at = NOW()`);
    values.push(user.id);

    await prisma.$executeRawUnsafe(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${idx}`,
      ...values
    );

    const updated = await prisma.$queryRawUnsafe<any[]>('SELECT * FROM users WHERE id = $1', user.id);
    return res.json({ user: safeUser(updated[0]) });
  } catch (error) {
    console.error('Profile update error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── PUT /api/auth/preferences ─────────────────────────────────────────────────
// Saves user preferences (city, theme, language, etc.) as JSONB

router.put('/preferences', async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.replace('Bearer ', '').trim();
    if (!token) return res.status(401).json({ error: 'Unauthorized' });

    const user = await getUserByToken(token);
    if (!user) return res.status(401).json({ error: 'Invalid or expired session' });

    const { city, theme, language, ...rest } = req.body;
    const current = user.preferences || {};
    const merged = { ...current, ...rest };
    if (city !== undefined) merged.city = city;
    if (theme !== undefined) merged.theme = theme;
    if (language !== undefined) merged.language = language;

    // Also update city column directly if provided
    if (city !== undefined) {
      await prisma.$executeRawUnsafe(
        `UPDATE users SET city = $1, preferences = $2::jsonb, updated_at = NOW() WHERE id = $3`,
        city, JSON.stringify(merged), user.id
      );
    } else {
      await prisma.$executeRawUnsafe(
        `UPDATE users SET preferences = $1::jsonb, updated_at = NOW() WHERE id = $2`,
        JSON.stringify(merged), user.id
      );
    }

    const updated = await prisma.$queryRawUnsafe<any[]>('SELECT * FROM users WHERE id = $1', user.id);
    return res.json({ user: safeUser(updated[0]) });
  } catch (error) {
    console.error('Preferences update error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/auth/change-password ───────────────────────────────────────────

router.post('/change-password', async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.replace('Bearer ', '').trim();
    if (!token) return res.status(401).json({ error: 'Unauthorized' });

    const user = await getUserByToken(token);
    if (!user) return res.status(401).json({ error: 'Invalid or expired session' });

    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both passwords required' });

    const ok = await bcrypt.compare(currentPassword, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Current password is incorrect' });

    const { valid, message } = validatePassword(newPassword);
    if (!valid) return res.status(400).json({ error: message });

    const hash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    await prisma.$executeRawUnsafe('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', hash, user.id);

    // Revoke all OTHER tokens (keep current)
    await prisma.$executeRawUnsafe('DELETE FROM auth_tokens WHERE user_id = $1 AND token != $2', user.id, token);

    return res.json({ success: true });
  } catch (error) {
    console.error('Change password error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/auth/cart/sync ──────────────────────────────────────────────────

router.post('/cart/sync', async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.replace('Bearer ', '').trim();
    if (!token) return res.status(401).json({ error: 'Unauthorized' });

    const user = await getUserByToken(token);
    if (!user) return res.status(401).json({ error: 'Invalid or expired session' });

    const { cart, name } = req.body;
    if (!Array.isArray(cart)) return res.status(400).json({ error: 'cart must be an array' });

    const cartName = name || 'Mon panier';
    const expiresAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);

    // Upsert: delete old ones, insert new
    await prisma.$executeRawUnsafe('DELETE FROM user_carts WHERE user_id = $1', user.id);
    await prisma.$executeRawUnsafe(
      `INSERT INTO user_carts (user_id, name, items, saved_at, expires_at)
       VALUES ($1, $2, $3::jsonb, NOW(), $4)`,
      user.id,
      cartName,
      JSON.stringify(cart),
      expiresAt
    );

    return res.json({ success: true });
  } catch (error) {
    console.error('Cart sync error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/auth/cart ────────────────────────────────────────────────────────

router.get('/cart', async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.replace('Bearer ', '').trim();
    if (!token) return res.status(401).json({ error: 'Unauthorized' });

    const user = await getUserByToken(token);
    if (!user) return res.status(401).json({ error: 'Invalid or expired session' });

    // Clean expired carts
    await prisma.$executeRawUnsafe('DELETE FROM user_carts WHERE expires_at < NOW()');

    const rows = await prisma.$queryRawUnsafe<any[]>(
      'SELECT * FROM user_carts WHERE user_id = $1 ORDER BY saved_at DESC LIMIT 1',
      user.id
    );

    return res.json({ cart: rows[0]?.items || [], savedAt: rows[0]?.saved_at || null });
  } catch (error) {
    console.error('Cart fetch error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Subscription helpers ──────────────────────────────────────────────────────

const PLAN_PRICES: Record<string, number> = { free: 0, pro: 9.90, max: 19.90 };
const PLAN_ORDER: Record<string, number> = { free: 0, pro: 1, max: 2 };

// ── GET /api/auth/subscription ────────────────────────────────────────────────

router.get('/subscription', async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.replace('Bearer ', '').trim();
    if (!token) return res.status(401).json({ error: 'Unauthorized' });

    const user = await getUserByToken(token);
    if (!user) return res.status(401).json({ error: 'Invalid or expired session' });

    return res.json({
      plan: user.plan,
      status: user.subscription_status || 'free',
      startedAt: user.subscription_started_at || null,
      currentPeriodEnd: user.subscription_current_period_end || null,
      cancelledAt: user.subscription_cancelled_at || null,
      lastPrice: user.subscription_last_price || null,
      invoiceCount: user.subscription_invoice_count || 0,
    });
  } catch (error) {
    console.error('Subscription fetch error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/auth/subscription/upgrade ──────────────────────────────────────

router.post('/subscription/upgrade', async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.replace('Bearer ', '').trim();
    if (!token) return res.status(401).json({ error: 'Unauthorized' });

    const user = await getUserByToken(token);
    if (!user) return res.status(401).json({ error: 'Invalid or expired session' });

    const { plan } = req.body;
    if (!plan || !['pro', 'max'].includes(plan)) {
      return res.status(400).json({ error: 'Invalid plan. Choose pro or max.' });
    }

    const currentPlan = user.plan || 'free';
    const currentOrder = PLAN_ORDER[currentPlan] ?? 0;
    const newOrder = PLAN_ORDER[plan] ?? 0;

    if (newOrder <= currentOrder && user.subscription_status === 'active') {
      return res.status(400).json({ error: 'Cannot downgrade via this endpoint.' });
    }

    const now = new Date();
    const newPrice = PLAN_PRICES[plan];
    let prorataCredit = 0;

    // Calculate prorata credit if upgrading from active paid plan
    if (
      currentPlan !== 'free' &&
      user.subscription_status === 'active' &&
      user.subscription_current_period_end &&
      newOrder > currentOrder
    ) {
      const periodEnd = new Date(user.subscription_current_period_end);
      const totalMs = 30 * 24 * 60 * 60 * 1000; // 30-day billing cycle
      const remainingMs = Math.max(0, periodEnd.getTime() - now.getTime());
      const oldPrice = PLAN_PRICES[currentPlan] || 0;
      prorataCredit = parseFloat(((remainingMs / totalMs) * oldPrice).toFixed(2));
    }

    const chargedAmount = Math.max(0, newPrice - prorataCredit);

    // New period: 30 days from today
    const periodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const invoiceCount = (user.subscription_invoice_count || 0) + 1;

    await prisma.$executeRawUnsafe(
      `UPDATE users SET
        plan = $1,
        subscription_status = 'active',
        subscription_started_at = COALESCE(subscription_started_at, $2),
        subscription_current_period_end = $3,
        subscription_cancelled_at = NULL,
        subscription_last_price = $4,
        subscription_invoice_count = $5,
        updated_at = NOW()
       WHERE id = $6`,
      plan, now, periodEnd, chargedAmount, invoiceCount, user.id
    );

    const updated = await prisma.$queryRawUnsafe<any[]>('SELECT * FROM users WHERE id = $1', user.id);
    return res.json({
      success: true,
      charged: chargedAmount,
      prorataCredit,
      user: safeUser(updated[0]),
      subscription: {
        plan,
        status: 'active',
        startedAt: updated[0].subscription_started_at,
        currentPeriodEnd: updated[0].subscription_current_period_end,
        lastPrice: chargedAmount,
        invoiceCount,
      }
    });
  } catch (error) {
    console.error('Subscription upgrade error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/auth/subscription/cancel ───────────────────────────────────────

router.post('/subscription/cancel', async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.replace('Bearer ', '').trim();
    if (!token) return res.status(401).json({ error: 'Unauthorized' });

    const user = await getUserByToken(token);
    if (!user) return res.status(401).json({ error: 'Invalid or expired session' });

    if (user.plan === 'free' || user.subscription_status === 'cancelled') {
      return res.status(400).json({ error: 'No active subscription to cancel.' });
    }

    const now = new Date();
    // Mark as cancelled — keeps access until period end
    await prisma.$executeRawUnsafe(
      `UPDATE users SET
        subscription_status = 'cancelled',
        subscription_cancelled_at = $1,
        updated_at = NOW()
       WHERE id = $2`,
      now, user.id
    );

    const updated = await prisma.$queryRawUnsafe<any[]>('SELECT * FROM users WHERE id = $1', user.id);
    return res.json({
      success: true,
      message: 'Subscription cancelled. Access remains until period end.',
      currentPeriodEnd: updated[0].subscription_current_period_end,
      user: safeUser(updated[0]),
    });
  } catch (error) {
    console.error('Subscription cancel error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/auth/subscription/renew ────────────────────────────────────────

router.post('/subscription/renew', async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.replace('Bearer ', '').trim();
    if (!token) return res.status(401).json({ error: 'Unauthorized' });

    const user = await getUserByToken(token);
    if (!user) return res.status(401).json({ error: 'Invalid or expired session' });

    if (user.plan === 'free' || user.subscription_status !== 'cancelled') {
      return res.status(400).json({ error: 'No cancelled subscription to renew.' });
    }

    const now = new Date();
    // Only allow renew if the period hasn't ended yet
    if (user.subscription_current_period_end && new Date(user.subscription_current_period_end) < now) {
      return res.status(400).json({ error: 'Subscription has already expired.' });
    }

    // Revert cancelled state
    await prisma.$executeRawUnsafe(
      `UPDATE users SET
        subscription_status = 'active',
        subscription_cancelled_at = NULL,
        updated_at = NOW()
       WHERE id = $1`,
      user.id
    );

    const updated = await prisma.$queryRawUnsafe<any[]>('SELECT * FROM users WHERE id = $1', user.id);
    return res.json({
      success: true,
      message: 'Subscription renewed successfully.',
      user: safeUser(updated[0]),
    });
  } catch (error) {
    console.error('Subscription renew error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
