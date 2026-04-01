// routes/optfiles.js
const router = require('express').Router();
const db     = require('../db');
const { requireAuth } = require('../middleware/auth');
router.use(requireAuth);

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM opt_files ORDER BY created_at DESC').all();
  res.json(rows.map(r => ({
    ...r,
    cut_pieces:    JSON.parse(r.cut_pieces||'[]'),
    manual_pieces: JSON.parse(r.manual_pieces||'[]'),
    order_ids:     JSON.parse(r.order_ids||'[]'),
    raw_sheet_snap:r.raw_sheet_snap ? JSON.parse(r.raw_sheet_snap) : null,
    results:       r.results ? JSON.parse(r.results) : null
  })));
});

router.get('/:id', (req, res) => {
  const r = db.prepare('SELECT * FROM opt_files WHERE id=?').get(+req.params.id);
  if (!r) return res.status(404).json({error:'Not found'});
  res.json({
    ...r,
    cut_pieces:    JSON.parse(r.cut_pieces||'[]'),
    manual_pieces: JSON.parse(r.manual_pieces||'[]'),
    order_ids:     JSON.parse(r.order_ids||'[]'),
    raw_sheet_snap:r.raw_sheet_snap ? JSON.parse(r.raw_sheet_snap) : null,
    results:       r.results ? JSON.parse(r.results) : null
  });
});

router.post('/', (req, res) => {
  try {
    const { name, raw_sheet_id, raw_sheet_snap, comp_w, comp_h, cut_pieces, manual_pieces, results, order_ids } = req.body;
    const r = db.prepare(`
      INSERT INTO opt_files (name,raw_sheet_id,raw_sheet_snap,comp_w,comp_h,cut_pieces,manual_pieces,results,order_ids)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(
      name, raw_sheet_id||null,
      raw_sheet_snap ? JSON.stringify(raw_sheet_snap) : null,
      +comp_w||0, +comp_h||0,
      JSON.stringify(cut_pieces||[]),
      JSON.stringify(manual_pieces||[]),
      results ? JSON.stringify(results) : null,
      JSON.stringify(order_ids||[])
    );
    res.status(201).json(db.prepare('SELECT * FROM opt_files WHERE id=?').get(r.lastInsertRowid));
  } catch(e){ res.status(500).json({error:e.message}); }
});

router.put('/:id', (req, res) => {
  try {
    const { name, status, raw_sheet_id, raw_sheet_snap, comp_w, comp_h, cut_pieces, manual_pieces, results, order_ids } = req.body;
    db.prepare(`
      UPDATE opt_files SET name=?,status=?,raw_sheet_id=?,raw_sheet_snap=?,comp_w=?,comp_h=?,
        cut_pieces=?,manual_pieces=?,results=?,order_ids=?,updated_at=datetime('now'),
        completed_at=CASE WHEN ?='done' THEN datetime('now') ELSE completed_at END
      WHERE id=?
    `).run(
      name, status||'pending', raw_sheet_id||null,
      raw_sheet_snap ? JSON.stringify(raw_sheet_snap) : null,
      +comp_w||0, +comp_h||0,
      JSON.stringify(cut_pieces||[]),
      JSON.stringify(manual_pieces||[]),
      results ? JSON.stringify(results) : null,
      JSON.stringify(order_ids||[]),
      status||'pending', +req.params.id
    );
    const r2 = db.prepare('SELECT * FROM opt_files WHERE id=?').get(+req.params.id);
    res.json({
      ...r2,
      cut_pieces:    JSON.parse(r2.cut_pieces||'[]'),
      manual_pieces: JSON.parse(r2.manual_pieces||'[]'),
      order_ids:     JSON.parse(r2.order_ids||'[]'),
      raw_sheet_snap:r2.raw_sheet_snap ? JSON.parse(r2.raw_sheet_snap) : null,
      results:       r2.results ? JSON.parse(r2.results) : null
    });
  } catch(e){ res.status(500).json({error:e.message}); }
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM opt_files WHERE id=?').run(+req.params.id);
  res.json({ok:true});
});

module.exports = router;
