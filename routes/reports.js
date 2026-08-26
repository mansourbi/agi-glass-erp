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
    if (from) { where += ' AND sl.ts>=?'; params.push(String(from).replace("T"," ")); }
    if (to)   { where += ' AND sl.ts<=?'; params.push(String(to).replace("T"," ")); }
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

// ── NEW: Per-process KPI breakdown (productivity-v2) ───────────────────────
// GET /api/reports/productivity-v2?from=ISO&to=ISO
// Returns structured KPIs per process, with appropriate groupings.
// Counting: one piece counts for a process if that process has >=1 scan_log
// row with action='done' and ts within [from, to]. Aggregations are joined
// against label_items for dimensions (w, h, thickness, bevel_mm, drill_count,
// cutout_count). Linear meter = (w+h)*2/1000 = full piece perimeter (upper
// bound — per-edge accuracy is postponed).
router.get('/productivity-v2', (req, res) => {
  try {
    const { from, to } = req.query;
    let where = "WHERE sl.action='done'";
    const params = [];
    if (from) { where += ' AND sl.ts>=?'; params.push(String(from).replace("T"," ")); }
    if (to)   { where += ' AND sl.ts<=?'; params.push(String(to).replace("T"," ")); }

    // Each (piece, process) done in the period becomes one aggregation row.
    // DISTINCT to avoid double-counting when a worker scans the same piece
    // twice for the same process (shouldn't happen normally, but safety).
    const rows = db.prepare(`
      SELECT DISTINCT sl.piece_uid, sl.process,
        li.w, li.h, li.thickness, li.bevel_mm, li.drill_count, li.cutout_count
      FROM scan_log sl
      LEFT JOIN label_items li ON li.uid=sl.piece_uid
      ${where}
    `).all(...params);

    // Helper: initialize a generic per-process accumulator
    function mkProc(){ return {totalPieces:0,totalSqm:0,totalLinM:0,_groups:{}}; }
    // Helper: ensure a group exists in the breakdown map
    function getGroup(proc, key){
      if(!proc._groups[key]) proc._groups[key] = {pieces:0,sqm:0,linM:0};
      return proc._groups[key];
    }

    const cutting  = mkProc();
    const flat     = mkProc();
    const round    = mkProc();
    const arrising = mkProc();
    const bevel    = mkProc();
    const drilling = {totalPieces:0, totalDrills:0};
    const cutouts  = {totalPieces:0, totalCutouts:0};

    for (const r of rows) {
      // Skip scan rows where the piece has been deleted from label_items
      if (r.w == null || r.h == null) continue;
      const sqm = (r.w * r.h) / 1e6;
      const linM = ((r.w + r.h) * 2) / 1000;
      const t = r.thickness || 0;

      // Process-specific aggregation
      if (r.process === 'cutting') {
        cutting.totalPieces += 1; cutting.totalSqm += sqm;
        const g = getGroup(cutting, t);
        g.pieces += 1; g.sqm += sqm;
      } else if (r.process === 'flat') {
        flat.totalPieces += 1; flat.totalSqm += sqm; flat.totalLinM += linM;
        const g = getGroup(flat, t);
        g.pieces += 1; g.sqm += sqm; g.linM += linM;
      } else if (r.process === 'round') {
        round.totalPieces += 1; round.totalSqm += sqm; round.totalLinM += linM;
        const g = getGroup(round, t);
        g.pieces += 1; g.sqm += sqm; g.linM += linM;
      } else if (r.process === 'arrising') {
        arrising.totalPieces += 1; arrising.totalSqm += sqm; arrising.totalLinM += linM;
        const g = getGroup(arrising, t);
        g.pieces += 1; g.sqm += sqm; g.linM += linM;
      } else if (r.process === 'bevel') {
        bevel.totalPieces += 1; bevel.totalSqm += sqm; bevel.totalLinM += linM;
        const bw = r.bevel_mm || 0;
        const g = getGroup(bevel, bw);
        g.pieces += 1; g.sqm += sqm; g.linM += linM;
      } else if (r.process === 'drilling') {
        drilling.totalPieces += 1;
        drilling.totalDrills += (r.drill_count || 0);
      } else if (r.process === 'cutouts') {
        cutouts.totalPieces += 1;
        cutouts.totalCutouts += (r.cutout_count || 0);
      }
      // Other processes (tempering, laminating, paint, sandblasting, poly, igu)
      // are not in the KPI spec → ignored here (they'll still count in the
      // legacy /productivity endpoint which is used elsewhere).
    }

    // Shape breakdown maps into sorted arrays
    function shapeByThick(proc){
      const arr = Object.entries(proc._groups)
        .map(([k,v]) => ({thickness:+k, pieces:v.pieces, sqm:+v.sqm.toFixed(3), linM:+(v.linM||0).toFixed(2)}))
        .sort((a,b) => a.thickness - b.thickness);
      return arr;
    }
    function shapeByBevel(proc){
      const arr = Object.entries(proc._groups)
        .map(([k,v]) => ({bevelMM:+k, pieces:v.pieces, sqm:+v.sqm.toFixed(3), linM:+(v.linM||0).toFixed(2)}))
        .sort((a,b) => a.bevelMM - b.bevelMM);
      return arr;
    }
    // Strip linM from cutting's thickness groups (cutting has no linM KPI)
    function shapeByThickNoLin(proc){
      return Object.entries(proc._groups)
        .map(([k,v]) => ({thickness:+k, pieces:v.pieces, sqm:+v.sqm.toFixed(3)}))
        .sort((a,b) => a.thickness - b.thickness);
    }

    res.json({
      period: { from: from||null, to: to||null },
      cutting: {
        totalPieces: cutting.totalPieces,
        totalSqm: +cutting.totalSqm.toFixed(3),
        byThickness: shapeByThickNoLin(cutting)
      },
      flat: {
        totalPieces: flat.totalPieces,
        totalSqm: +flat.totalSqm.toFixed(3),
        totalLinM: +flat.totalLinM.toFixed(2),
        byThickness: shapeByThick(flat)
      },
      round: {
        totalPieces: round.totalPieces,
        totalSqm: +round.totalSqm.toFixed(3),
        totalLinM: +round.totalLinM.toFixed(2),
        byThickness: shapeByThick(round)
      },
      arrising: {
        totalPieces: arrising.totalPieces,
        totalSqm: +arrising.totalSqm.toFixed(3),
        totalLinM: +arrising.totalLinM.toFixed(2),
        byThickness: shapeByThick(arrising)
      },
      bevel: {
        totalPieces: bevel.totalPieces,
        totalSqm: +bevel.totalSqm.toFixed(3),
        totalLinM: +bevel.totalLinM.toFixed(2),
        byBevelWidth: shapeByBevel(bevel)
      },
      drilling,
      cutouts
    });
  } catch(e){ console.error('[productivity-v2]', e); res.status(500).json({error:e.message}); }
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

// ── Raw scan rows (for Excel export) ───────────────────────────────────────
// GET /api/reports/productivity-raw?from=ISO&to=ISO
// Returns one row per scan_log entry (action='done') joined with piece dims.
// Lets the user slice however they like in Excel.
router.get('/productivity-raw', (req, res) => {
  try {
    const { from, to } = req.query;
    let where = "WHERE sl.action='done'";
    const params = [];
    if (from) { where += ' AND sl.ts>=?'; params.push(String(from).replace("T"," ")); }
    if (to)   { where += ' AND sl.ts<=?'; params.push(String(to).replace("T"," ")); }
    const rows = db.prepare(`
      SELECT
        sl.ts                AS scan_ts,
        sl.process           AS process,
        sl.worker_id         AS worker_id,
        sl.worker_name       AS worker_name,
        sl.piece_uid         AS piece_uid,
        sl.order_id          AS order_id,
        sl.order_num         AS order_num,
        li.code              AS piece_code,
        li.w                 AS width_mm,
        li.h                 AS height_mm,
        li.thickness         AS thickness_mm,
        li.glass_type        AS glass_type,
        li.color             AS color,
        li.bevel_mm          AS bevel_mm,
        li.drill_count       AS drill_count,
        li.cutout_count      AS cutout_count,
        li.cut_type          AS cut_type,
        li.date              AS cut_date
      FROM scan_log sl
      LEFT JOIN label_items li ON li.uid=sl.piece_uid
      ${where}
      ORDER BY sl.ts
    `).all(...params);
    res.json(rows);
  } catch(e){ console.error('[productivity-raw]', e); res.status(500).json({error:e.message}); }
});

module.exports = router;
