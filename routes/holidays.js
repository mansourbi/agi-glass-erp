// routes/holidays.js
const router = require('express').Router();
const db     = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');

router.use(requireAuth);

// Schema migration
try {
  db.prepare(`CREATE TABLE IF NOT EXISTS holidays (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    date       TEXT NOT NULL UNIQUE,
    name       TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )`).run();
} catch(e) {}

// GET / — list all holidays (optionally filter by year)
router.get('/', (req, res) => {
  try {
    const { year } = req.query;
    const rows = year
      ? db.prepare(`SELECT * FROM holidays WHERE date LIKE ? ORDER BY date ASC`).all(year + '%')
      : db.prepare(`SELECT * FROM holidays ORDER BY date ASC`).all();
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST / — add a holiday
router.post('/', requireAdmin, (req, res) => {
  try {
    const { date, name } = req.body;
    if (!date || !name) return res.status(400).json({ error: 'date and name required' });
    const r = db.prepare(`INSERT INTO holidays (date, name) VALUES (?, ?)`).run(date, name.trim());
    res.status(201).json(db.prepare('SELECT * FROM holidays WHERE id=?').get(r.lastInsertRowid));
  } catch(e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Holiday already exists for this date' });
    res.status(500).json({ error: e.message });
  }
});

// PUT /:id — update holiday
router.put('/:id', requireAdmin, (req, res) => {
  try {
    const { date, name } = req.body;
    if (!date || !name) return res.status(400).json({ error: 'date and name required' });
    db.prepare(`UPDATE holidays SET date=?, name=? WHERE id=?`).run(date, name.trim(), +req.params.id);
    res.json(db.prepare('SELECT * FROM holidays WHERE id=?').get(+req.params.id));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /:id
router.delete('/:id', requireAdmin, (req, res) => {
  try {
    db.prepare('DELETE FROM holidays WHERE id=?').run(+req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /check/:date — check if a date is a holiday
router.get('/check/:date', (req, res) => {
  try {
    const h = db.prepare('SELECT * FROM holidays WHERE date=?').get(req.params.date);
    res.json({ is_holiday: !!h, holiday: h || null });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
