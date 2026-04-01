// routes/reports.js
const router = require('express').Router();
const db     = require('../db');
const { requireAuth } = require('../middleware/auth');
router.use(requireAuth);

router.get('/productivity', (req, res) => {
  try {
    const { from, to } = req.query;
    let where = "WHERE sl.action='done'";
    const params = [];
    if (from) { where += ' AND sl.ts>=?'; params.push(from); }
    if (to)   { where += ' AND sl.ts<=?'; params.push(to); }
    const rows = db.prepare(`
      SELECT sl.process,
        COUNT(*) AS pieces_done,
        COALESCE(SUM(li.w*li.h/1000000.0),0) AS total_sqm,
        COALESCE(SUM((li.w+li.h)*2.0/1000.0),0) AS total_lin_m,
        COUNT(DISTINCT sl.worker_id) AS worker_count,
        GROUP_CONCAT(DISTINCT sl.worker_name) AS workers
      FROM scan_log sl
      LEFT JOIN label_items li ON li.uid=sl.piece_uid
      ${where}
      GROUP BY sl.process ORDER BY pieces_done DESC
    `).all(...params);
    res.json(rows);
  } catch(e){ res.status(500).json({error:e.message}); }
});

router.get('/workers', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT w.id,w.name,w.role,sl.process,
        COUNT(*) AS pieces_done,
        COALESCE(SUM(li.w*li.h/1000000.0),0) AS total_sqm,
        MIN(sl.ts) AS first_scan, MAX(sl.ts) AS last_scan
      FROM workers w
      LEFT JOIN scan_log sl ON sl.worker_id=w.id AND sl.action='done'
      LEFT JOIN label_items li ON li.uid=sl.piece_uid
      GROUP BY w.id,sl.process ORDER BY w.name,sl.process
    `).all();
    const byWorker = {};
    rows.forEach(r => {
      if (!byWorker[r.id]) byWorker[r.id] = { id:r.id, name:r.name, role:r.role, processes:[] };
      if (r.process) byWorker[r.id].processes.push({
        process:r.process, pieces_done:r.pieces_done,
        total_sqm:r.total_sqm, first_scan:r.first_scan, last_scan:r.last_scan
      });
    });
    res.json(Object.values(byWorker));
  } catch(e){ res.status(500).json({error:e.message}); }
});

router.get('/orders', (req, res) => {
  try {
    res.json(db.prepare(`
      SELECT o.*,c.name AS customer_name,c.code AS customer_code,
        COALESCE((SELECT SUM(qty) FROM order_items WHERE order_id=o.id),0) AS total_pieces,
        COALESCE((SELECT SUM(w*h*qty) FROM order_items WHERE order_id=o.id),0)/1000000.0 AS total_sqm
      FROM orders o JOIN customers c ON c.id=o.customer_id ORDER BY o.id DESC
    `).all());
  } catch(e){ res.status(500).json({error:e.message}); }
});

router.get('/tracking/:orderId', (req, res) => {
  try {
    const pieces = db.prepare('SELECT * FROM label_items WHERE order_id=? ORDER BY uid').all(+req.params.orderId);
    const result = pieces.map(p => {
      const logs = db.prepare('SELECT * FROM scan_log WHERE piece_uid=? ORDER BY ts').all(p.uid);
      const byProc = {};
      logs.forEach(l => {
        if (!byProc[l.process]) byProc[l.process] = {};
        byProc[l.process][l.action] = { ts:l.ts, worker:l.worker_name };
      });
      return { ...p, processes: JSON.parse(p.processes||'[]'), procStatus: byProc };
    });
    res.json(result);
  } catch(e){ res.status(500).json({error:e.message}); }
});

module.exports = router;
