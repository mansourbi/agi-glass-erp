// routes/auth.js
const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const db      = require('../db');
const { signToken, requireAuth } = require('../middleware/auth');

// POST /api/auth/login
router.post('/login', (req, res) => {
  try {
    const { email, password, device_id } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: 'Email and password required' });

    const worker = db.prepare(
      'SELECT * FROM workers WHERE email = ? AND is_active = 1'
    ).get(email.trim().toLowerCase());

    if (!worker)
      return res.status(401).json({ error: 'Invalid email or password' });

    if (!bcrypt.compareSync(password, worker.pass_hash))
      return res.status(401).json({ error: 'Invalid email or password' });

    // Device approval check (workers only, not admins)
    if (worker.role !== 'admin') {
      if (!device_id) {
        return res.status(403).json({
          error: 'Device verification required. Please use the worker app.',
          code: 'DEVICE_REQUIRED'
        });
      }
      const existingDevice = worker.device_id;
      const existingStatus = worker.device_status;
      if (!existingDevice) {
        // First time — register as pending and block
        db.prepare('UPDATE workers SET device_id=?, device_status=?, device_registered_at=? WHERE id=?')
          .run(device_id, 'pending', new Date().toISOString(), worker.id);
        return res.status(403).json({
          error: 'Device registration pending admin approval. Contact your administrator.',
          code: 'DEVICE_PENDING'
        });
      }
      if (existingDevice !== device_id) {
        return res.status(403).json({
          error: 'This account is bound to a different device. Contact admin to reset.',
          code: 'DEVICE_MISMATCH'
        });
      }
      if (existingStatus === 'pending') {
        return res.status(403).json({
          error: 'Device approval pending. Contact your administrator.',
          code: 'DEVICE_PENDING'
        });
      }
      if (existingStatus === 'rejected') {
        return res.status(403).json({
          error: 'Device access has been rejected. Contact admin.',
          code: 'DEVICE_REJECTED'
        });
      }
      // existingStatus === 'approved' — fall through to issue token
    }

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
