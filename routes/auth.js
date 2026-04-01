// routes/auth.js
const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const db      = require('../db');
const { signToken, requireAuth } = require('../middleware/auth');

// POST /api/auth/login
router.post('/login', (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: 'Email and password required' });

    const worker = db.prepare(
      'SELECT * FROM workers WHERE email = ? AND is_active = 1'
    ).get(email.trim().toLowerCase());

    if (!worker)
      return res.status(401).json({ error: 'Invalid email or password' });

    if (!bcrypt.compareSync(password, worker.pass_hash))
      return res.status(401).json({ error: 'Invalid email or password' });

    const processes = JSON.parse(worker.processes || '[]');
    const token = signToken({
      id: worker.id, name: worker.name,
      email: worker.email, role: worker.role, processes
    }, worker.role === 'admin' ? '24h' : '12h');

    res.json({
      token,
      worker: { id: worker.id, name: worker.name, email: worker.email, role: worker.role, processes }
    });
  } catch (e) {
    console.error('[auth/login]', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/auth/me
router.get('/me', requireAuth, (req, res) => {
  res.json({ worker: req.user });
});

module.exports = router;
