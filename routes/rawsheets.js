// routes/rawsheets.js
const router = require('express').Router();
const db     = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
router.use(requireAuth);

// Normalize DB row: glass_type -> type for frontend compatibility
function normalize(row) {
  return { ...row, type: row.glass_type };
}

router.get('/', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM raw_sheets ORDER BY thickness,glass_type,color').all();
    res.json(rows.map(normalize));
  } catch(e) { res.status(500).json({error:e.message}); }
});

router.post('/', requireAdmin, (req, res) => {
  try {
    const { code, glass_type, type, color, thickness, w, h, company, origin, notes, stock_qty } = req.body;
    const gtype = glass_type || type || 'glass';
    const r = db.prepare(
      'INSERT INTO raw_sheets (code,glass_type,color,thickness,w,h,company,origin,notes,stock_qty) VALUES (?,?,?,?,?,?,?,?,?,?)'
    ).run(code, gtype, color||'clear', +thickness, +w, +h, company||null, origin||null, notes||null, +stock_qty||0);
    const row = db.prepare('SELECT * FROM raw_sheets WHERE id=?').get(r.lastInsertRowid);
    res.status(201).json(normalize(row));
  } catch(e) { res.status(500).json({error:e.message}); }
});

router.put('/:id', requireAdmin, (req, res) => {
  try {
    const { code, glass_type, type, color, thickness, w, h, company, origin, notes, stock_qty } = req.body;
    const gtype = glass_type || type || 'glass';
    db.prepare(
      `UPDATE raw_sheets SET code=?,glass_type=?,color=?,thickness=?,w=?,h=?,company=?,origin=?,notes=?,stock_qty=?,updated_at=datetime('now') WHERE id=?`
    ).run(code, gtype, color||'clear', +thickness, +w, +h, company||null, origin||null, notes||null, +stock_qty||0, +req.params.id);
    const row = db.prepare('SELECT * FROM raw_sheets WHERE id=?').get(+req.params.id);
    res.status(200).json(normalize(row));
  } catch(e) { res.status(500).json({error:e.message}); }
});

router.delete('/:id', requireAdmin, (req, res) => {
  try {
    db.prepare('DELETE FROM raw_sheets WHERE id=?').run(+req.params.id);
    res.json({ok:true});
  } catch(e) { res.status(500).json({error:e.message}); }
});

module.exports = router;
