// routes/external_processes.js
const router = require('express').Router();
const db     = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
router.use(requireAuth);

// Create table + migrate orders column
try {
  db.prepare(`CREATE TABLE IF NOT EXISTS external_processes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    active INTEGER DEFAULT 1,
    sort_order INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT (datetime('now'))
  )`).run();
} catch(e) {}
try { db.prepare('ALTER TABLE orders ADD COLUMN external_process_id INTEGER').run(); } catch(e) {}
try { db.prepare('ALTER TABLE deliveries ADD COLUMN external_process_id INTEGER').run(); } catch(e) {}
try { db.prepare('ALTER TABLE deliveries ADD COLUMN external_process_name TEXT').run(); } catch(e) {}

// GET all
router.get('/', (req, res) => {
  try {
    res.json(db.prepare('SELECT * FROM external_processes ORDER BY sort_order, name').all());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST create
router.post('/', requireAdmin, (req, res) => {
  try {
    const { name, sort_order } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'name required' });
    const r = db.prepare('INSERT INTO external_processes (name, sort_order) VALUES (?,?)').run(name.trim(), sort_order||0);
    res.status(201).json(db.prepare('SELECT * FROM external_processes WHERE id=?').get(r.lastInsertRowid));
  } catch(e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Name already exists' });
    res.status(500).json({ error: e.message });
  }
});

// PUT update
router.put('/:id', requireAdmin, (req, res) => {
  try {
    const { name, active, sort_order } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'name required' });
    db.prepare('UPDATE external_processes SET name=?, active=?, sort_order=? WHERE id=?')
      .run(name.trim(), active === false ? 0 : 1, sort_order||0, +req.params.id);
    res.json(db.prepare('SELECT * FROM external_processes WHERE id=?').get(+req.params.id));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE
router.delete('/:id', requireAdmin, (req, res) => {
  try {
    const inUse = db.prepare('SELECT COUNT(*) AS c FROM orders WHERE external_process_id=?').get(+req.params.id).c;
    if (inUse > 0) return res.status(409).json({ error: `Cannot delete — used by ${inUse} order(s)` });
    db.prepare('DELETE FROM external_processes WHERE id=?').run(+req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
