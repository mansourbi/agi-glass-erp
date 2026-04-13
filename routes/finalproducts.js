// routes/finalproducts.js
const router = require('express').Router();
const db     = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
router.use(requireAuth);

// Ensure table exists
try {
  db.prepare(`CREATE TABLE IF NOT EXISTS final_products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'زجاج',
    subtype TEXT DEFAULT '',
    thickness TEXT DEFAULT '',
    glass_type TEXT DEFAULT '',
    color TEXT DEFAULT '',
    tempered TEXT DEFAULT '',
    edge TEXT DEFAULT '',
    process TEXT DEFAULT '',
    paint_color TEXT DEFAULT '',
    brand TEXT DEFAULT '',
    origin TEXT DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT (datetime('now'))
  )`).run();
} catch(e) { console.warn('[final_products init]', e.message); }
// Add final_product_id to orders if missing
try { db.prepare('ALTER TABLE orders ADD COLUMN final_product_id INTEGER').run(); } catch(e) {}

// Build label from parts
function buildLabel(d) {
  const parts = [d.category, d.subtype, d.thickness, d.glass_type, d.color,
    d.tempered, d.edge, d.process, d.paint_color, d.brand, d.origin];
  return parts.map(p => (p||'').trim()).filter(Boolean).join(' ');
}

// GET all
router.get('/', (req, res) => {
  try {
    res.json(db.prepare('SELECT * FROM final_products ORDER BY sort_order,category,label').all());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST create
router.post('/', requireAdmin, (req, res) => {
  try {
    const d = req.body;
    const label = d.label || buildLabel(d);
    const r = db.prepare(`INSERT INTO final_products
      (label,category,subtype,thickness,glass_type,color,tempered,edge,process,paint_color,brand,origin,sort_order)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      label, d.category||'زجاج', d.subtype||'', d.thickness||'',
      d.glass_type||'', d.color||'', d.tempered||'', d.edge||'',
      d.process||'', d.paint_color||'', d.brand||'', d.origin||'', d.sort_order||0
    );
    res.status(201).json(db.prepare('SELECT * FROM final_products WHERE id=?').get(r.lastInsertRowid));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT update
router.put('/:id', requireAdmin, (req, res) => {
  try {
    const d = req.body;
    const label = d.label || buildLabel(d);
    db.prepare(`UPDATE final_products SET
      label=?,category=?,subtype=?,thickness=?,glass_type=?,color=?,tempered=?,edge=?,
      process=?,paint_color=?,brand=?,origin=?,active=?,sort_order=? WHERE id=?`).run(
      label, d.category||'زجاج', d.subtype||'', d.thickness||'',
      d.glass_type||'', d.color||'', d.tempered||'', d.edge||'',
      d.process||'', d.paint_color||'', d.brand||'', d.origin||'',
      d.active===false?0:1, d.sort_order||0, +req.params.id
    );
    res.json(db.prepare('SELECT * FROM final_products WHERE id=?').get(+req.params.id));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE
router.delete('/:id', requireAdmin, (req, res) => {
  try {
    db.prepare('DELETE FROM final_products WHERE id=?').run(+req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /stats — orders count/qty/sqm per final product
router.get('/stats', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT fp.id, fp.label, fp.category,
        COUNT(DISTINCT o.id) AS order_count,
        COALESCE(SUM(oi.qty),0) AS total_qty,
        COALESCE(SUM(oi.w*oi.h*oi.qty),0)/1000000.0 AS total_sqm
      FROM final_products fp
      LEFT JOIN orders o ON o.final_product_id=fp.id
      LEFT JOIN order_items oi ON oi.order_id=o.id
      GROUP BY fp.id ORDER BY fp.sort_order,fp.label
    `).all();
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
