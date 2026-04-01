// routes/fpfields.js — lookup values for each Final Product field
const router = require('express').Router();
const db     = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
router.use(requireAuth);

const FIELDS = ['category','subtype','thickness','glass_type','color','tempered','edge','process','paint_color','brand','origin'];

try {
  db.prepare(`CREATE TABLE IF NOT EXISTS fp_field_values (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    field_name TEXT NOT NULL,
    value TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1,
    UNIQUE(field_name, value)
  )`).run();

  // Seed from the 62 known products
  const seeds = {
    category:    ['زجاج','مرايا'],
    subtype:     ['لمينتد'],
    thickness:   ['4','5','5.5+5.5','6','8','10','12','15','6+0.76+6','8+1.14+8','10+1.52+10'],
    glass_type:  ['فلوتد','مبزر','فيميه'],
    color:       ['clear','low-iron','bronze','grey','green','blue','black','white','antique','crystal'],
    tempered:    ['سيكوريت','بدون سيكوريت'],
    edge:        ['مربع','مبروم','حف'],
    process:     ['مدهون سيراميك','مدهون بارد','مغشى رمل','فيلم','فروستيد سيراميك'],
    paint_color: ['اسود','ابيض','رمادي','حليبي'],
    brand:       ['AGC','سان جوبان'],
    origin:      ['بلجيكي','صيني']
  };
  const ins = db.prepare('INSERT OR IGNORE INTO fp_field_values (field_name,value,sort_order) VALUES (?,?,?)');
  Object.entries(seeds).forEach(([field, vals]) =>
    vals.forEach((v,i) => ins.run(field, v, i))
  );
} catch(e) { console.warn('[fp_field_values init]', e.message); }

// GET /api/fpfields — all values grouped by field
router.get('/', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM fp_field_values ORDER BY field_name,sort_order,value').all();
    const grouped = {};
    FIELDS.forEach(f => grouped[f] = []);
    rows.forEach(r => { if(grouped[r.field_name]) grouped[r.field_name].push(r); });
    res.json(grouped);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST — add a value
router.post('/', requireAdmin, (req, res) => {
  try {
    const { field_name, value, sort_order } = req.body;
    if (!FIELDS.includes(field_name)) return res.status(400).json({ error: 'Invalid field_name' });
    if (!value?.trim()) return res.status(400).json({ error: 'value required' });
    const r = db.prepare('INSERT OR IGNORE INTO fp_field_values (field_name,value,sort_order) VALUES (?,?,?)')
      .run(field_name, value.trim(), sort_order||0);
    res.status(201).json(db.prepare('SELECT * FROM fp_field_values WHERE field_name=? AND value=?').get(field_name, value.trim()));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT /:id — update
router.put('/:id', requireAdmin, (req, res) => {
  try {
    const { value, sort_order, active } = req.body;
    db.prepare('UPDATE fp_field_values SET value=?,sort_order=?,active=? WHERE id=?')
      .run(value?.trim(), sort_order||0, active===false?0:1, +req.params.id);
    res.json(db.prepare('SELECT * FROM fp_field_values WHERE id=?').get(+req.params.id));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /:id
router.delete('/:id', requireAdmin, (req, res) => {
  try {
    db.prepare('DELETE FROM fp_field_values WHERE id=?').run(+req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
