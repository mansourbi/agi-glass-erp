// routes/purchases.js
const router = require('express').Router();
const db     = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
router.use(requireAuth);

// GET /api/purchases
router.get('/', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT p.*, p.sheet_id AS sheetId,
             rs.code AS sheet_code, rs.glass_type AS sheet_type,
             rs.color AS sheet_color, rs.thickness AS sheet_thickness,
             rs.w AS sheet_w, rs.h AS sheet_h
      FROM purchases p
      LEFT JOIN raw_sheets rs ON rs.id = p.sheet_id
      ORDER BY p.date DESC, p.id DESC
    `).all();
    res.json(rows);
  } catch(e){ res.status(500).json({error:e.message}); }
});

// POST /api/purchases
router.post('/', requireAdmin, (req, res) => {
  try {
    const { sheetId, sheet_id, qty, date, notes } = req.body;
    const sid = sheetId || sheet_id;
    if (!sid || !qty) return res.status(400).json({error:'sheetId and qty required'});
    const r = db.prepare(
      'INSERT INTO purchases (sheet_id,qty,date,notes) VALUES (?,?,?,?)'
    ).run(+sid, +qty, date||new Date().toISOString().slice(0,10), notes||null);
    res.status(201).json(db.prepare('SELECT * FROM purchases WHERE id=?').get(r.lastInsertRowid));
  } catch(e){ res.status(500).json({error:e.message}); }
});

// DELETE /api/purchases/:id
router.delete('/:id', requireAdmin, (req, res) => {
  try {
    db.prepare('DELETE FROM purchases WHERE id=?').run(+req.params.id);
    res.json({ok:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

module.exports = router;
