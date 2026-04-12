import { Router } from 'express';

const router = Router();

// GET /api/user/preferences
router.get('/preferences', async (req, res) => {
  try {
    // TODO: Récupérer les préférences utilisateur
    res.json({ preferences: null });
  } catch (error) {
    console.error('Get preferences error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/user/preferences
router.put('/preferences', async (req, res) => {
  try {
    // TODO: Mettre à jour les préférences
    res.json({ message: 'Not implemented yet' });
  } catch (error) {
    console.error('Update preferences error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
