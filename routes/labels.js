// routes/labels.js
const router = require('express').Router();
const db     = require('../db');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

// GET /api/labels?orderId=&optFileId=
router.get('/', (req, res) => {
  try {
    const { orderId, optFileId } = req.query;
    let sql = 'SELECT * FROM label_items WHERE 1=1';
    const params = [];
    if (orderId)   { sql += ' AND order_id=?';    params.push(+orderId); }
    if (optFileId) { sql += ' AND opt_file_id=?'; params.push(+optFileId); }
    sql += ' ORDER BY created_at DESC';
    const rows = db.prepare(sql).all(...params);
    res.json(rows.map(r => ({
      ...r,
      processes: JSON.parse(r.processes||'[]'),
      optFileId: r.opt_file_id,
      orderId: r.order_id,
      orderNum: r.order_num,
      glassType: r.glass_type,
      bevelMM: r.bevel_mm,
      cutType: r.cut_type
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/labels — upsert one or many labels after optimization
router.post('/', (req, res) => {
  try {
    const items = Array.isArray(req.body) ? req.body : [req.body];
    const upsert = db.prepare(`
      INSERT INTO label_items (uid,code,w,h,thickness,glass_type,color,processes,bevel_mm,
        order_id,order_num,opt_file_id,sheet_idx,cut_type,date)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(uid) DO UPDATE SET
        code=excluded.code, w=excluded.w, h=excluded.h,
        thickness=excluded.thickness, glass_type=excluded.glass_type, color=excluded.color,
        processes=excluded.processes, bevel_mm=excluded.bevel_mm,
        order_id=excluded.order_id, order_num=excluded.order_num,
        opt_file_id=excluded.opt_file_id, sheet_idx=excluded.sheet_idx,
        cut_type=excluded.cut_type, date=excluded.date
    `);
    const insertMany = db.transaction((arr) => {
      for (const l of arr) {
        upsert.run(
          l.uid, l.code||'', +l.w||0, +l.h||0, +l.thickness||6,
          l.glassType||l.glass_type||'glass', l.color||'clear',
          JSON.stringify(l.processes||[]), +l.bevelMM||+l.bevel_mm||0,
          l.orderId||l.order_id||null, l.orderNum||l.order_num||null,
          l.optFileId||l.opt_file_id||null, l.sheetIdx||l.sheet_idx||null,
          l.cutType||l.cut_type||'machine',
          l.date || new Date().toISOString().slice(0,10)
        );
      }
    });
    insertMany(items);
    res.json({ ok: true, count: items.length });
  } catch (e) { console.error('[labels POST]', e); res.status(500).json({ error: e.message }); }
});

// POST /api/labels/scan — worker marks a process done  ← MUST be before /:uid
router.post('/scan', (req, res) => {
  try {
    const { pieceUid, process, action } = req.body;
    if (!pieceUid || !process || !['start','done'].includes(action))
      return res.status(400).json({ error: 'pieceUid and process required' });

    const piece = db.prepare('SELECT uid,code,order_num,order_id FROM label_items WHERE uid=?').get(pieceUid);
    if (!piece) return res.status(404).json({ error: 'Piece not found: ' + pieceUid });

    // Ensure scan_log has item_code column (add if missing)
    try{ db.prepare('ALTER TABLE scan_log ADD COLUMN item_code TEXT').run(); }catch(e){}
    try{ db.prepare('ALTER TABLE scan_log ADD COLUMN order_id INTEGER').run(); }catch(e){}

    const r = db.prepare(`
      INSERT INTO scan_log (worker_id,worker_name,piece_uid,item_code,process,action,order_num,order_id)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(req.user.id, req.user.name, pieceUid, piece.code||null, process, action, piece.order_num||null, piece.order_id||null);

    // Auto-complete order when last piece's last process is marked done
    if (action === 'done' && piece.order_id) {
      try {
        const order = db.prepare('SELECT * FROM orders WHERE id=?').get(piece.order_id);
        if (order && order.status !== 'done' && order.status !== 'cancelled') {
          const items = db.prepare('SELECT * FROM order_items WHERE order_id=?').all(piece.order_id);
          let allDone = true;
          for (const item of items) {
            const procs = JSON.parse(item.processes || '[]');
            const uids  = JSON.parse(item.piece_uids || '[]');
            const resolvedUids = uids.length ? uids : [];
            for (const uid of resolvedUids) {
              for (const proc of procs) {
                const done = db.prepare(
                  "SELECT id FROM scan_log WHERE piece_uid=? AND process=? AND action='done' LIMIT 1"
                ).get(uid, proc);
                if (!done) { allDone = false; break; }
              }
              if (!allDone) break;
            }
            if (!allDone) break;
          }
          if (allDone) {
            const workerName = req.user.name || req.user.email || 'Worker';
            const now = new Date().toISOString();
            db.prepare(`UPDATE orders SET status='done',completed_at=?,completed_by=?,updated_at=datetime('now') WHERE id=?`)
              .run(now, workerName, piece.order_id);
          }
        }
      } catch(autoErr) { console.warn('[auto-complete]', autoErr.message); }
    }

    res.status(201).json(db.prepare('SELECT * FROM scan_log WHERE id=?').get(r.lastInsertRowid));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/labels/scan/history  ← MUST be before /:uid
router.get('/scan/history', (req, res) => {
  try {
    const limit = Math.min(200, +req.query.limit || 60);
    const wid   = req.user.role === 'admin' && req.query.workerId
                  ? +req.query.workerId : req.user.id;
    const rows  = db.prepare(
      'SELECT * FROM scan_log WHERE worker_id=? ORDER BY ts DESC LIMIT ?'
    ).all(wid, limit);
    res.json(rows.map(s=>({
      ...s,
      pieceUid:   s.piece_uid,
      workerId:   s.worker_id,
      workerName: s.worker_name,
      itemCode:   s.item_code,
      orderNum:   s.order_num
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/labels/scanlog — admin: all scan log entries
router.get('/scanlog', (req, res) => {
  try {
    const { orderId, from, to } = req.query;
    let sql = "SELECT * FROM scan_log WHERE 1=1";
    const params = [];
    if (orderId) { sql += ' AND order_id=?'; params.push(+orderId); }
    if (from)    { sql += ' AND ts>=?'; params.push(from); }
    if (to)      { sql += ' AND ts<=?'; params.push(to); }
    sql += ' ORDER BY ts DESC';
    const rows = db.prepare(sql).all(...params);
    res.json(rows.map(s=>({
      ...s,
      pieceUid:   s.piece_uid,
      workerId:   s.worker_id,
      workerName: s.worker_name,
      itemCode:   s.item_code,
      orderNum:   s.order_num,
      orderId:    s.order_id
    })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/labels/pending — pieces with undone processes for current worker
router.get('/pending', (req, res) => {
  try {
    // Get all label items
    const allLabels = db.prepare('SELECT * FROM label_items').all();
    // Get all 'done' scan log entries
    const doneLogs = db.prepare("SELECT piece_uid, process FROM scan_log WHERE action='done'").all();
    const doneSet = new Set(doneLogs.map(d => d.piece_uid + '|' + d.process));

    const workerProcs = req.query.processes ? req.query.processes.split(',') : [];

    const pending = allLabels
      .map(item => ({
        ...item,
        processes: JSON.parse(item.processes || '[]'),
        optFileId: item.opt_file_id,
        orderId: item.order_id,
        orderNum: item.order_num,
        glassType: item.glass_type,
        bevelMM: item.bevel_mm,
        cutType: item.cut_type
      }))
      .filter(item => {
        const procs = item.processes;
        // If worker has specific processes, only show those
        const relevant = workerProcs.length
          ? procs.filter(p => workerProcs.includes(p))
          : procs;
        if (!relevant.length) return false;
        // Keep if any relevant process is not yet done
        return relevant.some(p => !doneSet.has(item.uid + '|' + p));
      })
      .map(item => ({
        ...item,
        pendingProcs: (workerProcs.length
          ? item.processes.filter(p => workerProcs.includes(p))
          : item.processes
        ).filter(p => !doneSet.has(item.uid + '|' + p))
      }));

    res.json(pending);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/labels/:uid — single piece + scan log  ← wildcard LAST
router.get('/:uid', (req, res) => {
  try {
    const label = db.prepare('SELECT * FROM label_items WHERE uid=?').get(req.params.uid);
    if (!label) return res.status(404).json({ error: 'Piece not found: ' + req.params.uid });
    const logs = db.prepare(
      'SELECT * FROM scan_log WHERE piece_uid=? ORDER BY ts'
    ).all(req.params.uid);
    res.json({ ...label,
      processes: JSON.parse(label.processes||'[]'),
      optFileId: label.opt_file_id,
      orderId: label.order_id,
      orderNum: label.order_num,
      glassType: label.glass_type,
      bevelMM: label.bevel_mm,
      cutType: label.cut_type,
      scanLog: logs.map(s=>({
        ...s,
        pieceUid: s.piece_uid,
        workerId: s.worker_id,
        workerName: s.worker_name,
        itemCode: s.item_code,
        orderNum: s.order_num
      }))
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
