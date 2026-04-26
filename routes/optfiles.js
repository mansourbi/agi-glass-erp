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

// DELETE — Safe cascade with checks.
//
// The original DELETE only ran `DELETE FROM opt_files` which fails because
// label_items.opt_file_id has a FK to opt_files.id. This version cleans up
// children first.
//
// Rules:
//   1. Check for scans recorded against any piece UID from this opt.
//      If any → return 409 unless ?force=1 is passed (admin override).
//   2. Cascade-delete in one transaction:
//      - label_items (by opt_file_id) — removes the FK that was blocking
//      - scan_log (by piece_uid IN list) — only matters under force=1
//      - raw_sheet_transactions (ref_id=this opt, type='optimization_use')
//        — this returns sheets to inventory
//      - opt_files itself
router.delete('/:id', (req, res) => {
  const id = +req.params.id;
  const force = req.query.force === '1';

  try {
    const opt = db.prepare('SELECT * FROM opt_files WHERE id=?').get(id);
    if(!opt) return res.status(404).json({error:'Not found'});

    // Collect piece UIDs from cut_pieces + manual_pieces — used for scan_log lookup
    const cutPieces    = JSON.parse(opt.cut_pieces||'[]');
    const manualPieces = JSON.parse(opt.manual_pieces||'[]');
    const uids = [...cutPieces, ...manualPieces].map(p => p.uid).filter(Boolean);

    // Count scans against these UIDs
    let scanCount = 0;
    if(uids.length){
      const placeholders = uids.map(()=>'?').join(',');
      const r = db.prepare(`SELECT COUNT(*) AS c FROM scan_log WHERE piece_uid IN (${placeholders})`).get(...uids);
      scanCount = r ? r.c : 0;
    }

    if(!force && scanCount > 0){
      return res.status(409).json({
        error: 'Cannot delete: this optimization has already been worked on.',
        details: {
          scans: scanCount,
          message: `${scanCount} scan(s) recorded — pieces have entered processing.`,
          hint: 'Force-delete will permanently remove all scan history.'
        }
      });
    }

    // Cascade delete in a single transaction
    const txn = db.transaction(() => {
      // 1. label_items (the FK that was blocking)
      db.prepare(`DELETE FROM label_items WHERE opt_file_id=?`).run(id);

      // 2. scan_log entries for these piece UIDs (only relevant under force)
      if(uids.length){
        const placeholders = uids.map(()=>'?').join(',');
        db.prepare(`DELETE FROM scan_log WHERE piece_uid IN (${placeholders})`).run(...uids);
      }

      // 3. raw_sheet_transactions — return stock to inventory
      db.prepare(`DELETE FROM raw_sheet_transactions WHERE ref_id=? AND type='optimization_use'`).run(id);

      // 4. Finally, the opt_files row itself
      db.prepare('DELETE FROM opt_files WHERE id=?').run(id);
    });
    txn();

    res.json({
      ok: true,
      cleaned: { uids: uids.length, scans_removed: force ? scanCount : 0, force }
    });
  } catch(e){
    res.status(500).json({error: e.message});
  }
});

module.exports = router;
