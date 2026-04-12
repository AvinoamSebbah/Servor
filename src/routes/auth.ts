import { Router } from 'express';

const router = Router();

// POST /api/auth/signin
router.post('/signin', async (req, res) => {
  try {
    const { email, password } = req.body;

    // TODO: Implémenter l'authentification
    res.json({ message: 'Not implemented yet' });
  } catch (error) {
    console.error('Signin error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/signup
router.post('/signup', async (req, res) => {
  try {
    const { name, email, password } = req.body;

    // TODO: Implémenter l'inscription
    res.json({ message: 'Not implemented yet' });
  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/signout
router.post('/signout', async (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: 'Could not sign out' });
    }
    res.json({ success: true });
  });
});

// GET /api/auth/session
router.get('/session', async (req, res) => {
  // TODO: Retourner la session utilisateur
  res.json({ user: null });
});

export default router;
