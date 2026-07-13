// routes/remnants.js
const router = require('express').Router();
const db     = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
router.use(requireAuth);

// ── Create tables ─────────────────────────────────────────────────────────
try {
  db.prepare(`CREATE TABLE IF NOT EXISTS remnant_slots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    description TEXT DEFAULT '',
    active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT (datetime('now'))
  )`).run();

  db.prepare(`CREATE TABLE IF NOT EXISTS remnants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uid TEXT NOT NULL UNIQUE,
    w REAL NOT NULL,
    h REAL NOT NULL,
    thickness INTEGER NOT NULL,
    glass_type TEXT DEFAULT 'glass',
    color TEXT DEFAULT 'clear',
    brand TEXT DEFAULT '',
    origin TEXT DEFAULT '',
    sqm REAL,
    opt_file_id INTEGER,
    opt_file_name TEXT,
    raw_sheet_id INTEGER,
    raw_sheet_label TEXT,
    slot_id INTEGER,
    slot_code TEXT,
    status TEXT DEFAULT 'available',
    notes TEXT DEFAULT '',
    created_at DATETIME DEFAULT (datetime('now')),
    used_at DATETIME,
    used_for_order TEXT,
    used_for_piece TEXT,
    used_by_worker TEXT
  )`).run();

  db.prepare(`CREATE TABLE IF NOT EXISTS remnant_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    remnant_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    note TEXT DEFAULT '',
    worker_id INTEGER,
    worker_name TEXT,
    order_id INTEGER,
    order_num TEXT,
    piece_uid TEXT,
    ts DATETIME DEFAULT (datetime('now'))
  )`).run();
} catch(e) { console.warn('[remnants init]', e.message); }
// Add brand/origin columns to existing tables
try { db.prepare('ALTER TABLE remnants ADD COLUMN brand TEXT DEFAULT ""').run(); } catch(e) {}
try { db.prepare('ALTER TABLE remnants ADD COLUMN origin TEXT DEFAULT ""').run(); } catch(e) {}

// ── Helpers ───────────────────────────────────────────────────────────────
function genUid(thickness, color, brand, origin) {
  // Format: REM-{thickness}MM-{COLOR}-{BRAND}-{ORIGIN}-{serial}
  const serial = db.prepare("SELECT COUNT(*)+1 AS n FROM remnants").get().n;
  const serial4 = String(serial).padStart(4,'0');
  const col = (color||'CLR').replace(/\s+/g,'').substring(0,4).toUpperCase();
  const brnd = (brand||'').replace(/\s+/g,'').substring(0,4).toUpperCase();
  const orig = (origin||'').replace(/\s+/g,'').substring(0,3).toUpperCase();
  const parts = [`REM`, `${thickness}MM`, col];
  if(brnd) parts.push(brnd);
  if(orig) parts.push(orig);
  parts.push(serial4);
  return parts.join('-');
}

// ── SLOTS ─────────────────────────────────────────────────────────────────
router.get('/slots', (req, res) => {
  try { res.json(db.prepare('SELECT * FROM remnant_slots ORDER BY code').all()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/slots', requireAdmin, (req, res) => {
  try {
    const { code, description } = req.body;
    if (!code?.trim()) return res.status(400).json({ error: 'code required' });
    const r = db.prepare('INSERT OR IGNORE INTO remnant_slots (code,description) VALUES (?,?)')
      .run(code.trim().toUpperCase(), description||'');
    res.status(201).json(db.prepare('SELECT * FROM remnant_slots WHERE code=?').get(code.trim().toUpperCase()));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/slots/:id', requireAdmin, (req, res) => {
  try {
    const { code, description, active } = req.body;
    const _newCode = code?.trim().toUpperCase();
    db.prepare('UPDATE remnant_slots SET code=?,description=?,active=? WHERE id=?')
      .run(_newCode, description||'', active===false?0:1, +req.params.id);
    // cascade slot rename to remnants' cached slot_code so they never go stale
    if(_newCode) db.prepare('UPDATE remnants SET slot_code=? WHERE slot_id=?').run(_newCode, +req.params.id);
    res.json(db.prepare('SELECT * FROM remnant_slots WHERE id=?').get(+req.params.id));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/slots/:id', requireAdmin, (req, res) => {
  try {
    const count = db.prepare("SELECT COUNT(*) AS c FROM remnants WHERE slot_id=? AND status='available'").get(+req.params.id).c;
    if (count > 0) return res.status(400).json({ error: 'Slot has '+count+' active remnants. Move them first.' });
    db.prepare('DELETE FROM remnant_slots WHERE id=?').run(+req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── REMNANTS ──────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  try {
    const { status, thickness, color, slot_id, family, source, session_id } = req.query;
    let sql = 'SELECT * FROM remnants WHERE 1=1';
    const p = [];
    if (status)    { sql += ' AND status=?';    p.push(status); }
    if (thickness) { sql += ' AND thickness=?'; p.push(+thickness); }
    if (color)     { sql += ' AND color=?';     p.push(color); }
    if (slot_id)   { sql += ' AND slot_id=?';   p.push(+slot_id); }
    if (family)    { sql += ' AND family=?';    p.push(family); }
    if (source)    { sql += ' AND source=?';    p.push(source); }
    if (session_id){ sql += ' AND session_id=?';p.push(+session_id); }
    sql += ' ORDER BY created_at DESC';
    res.json(db.prepare(sql).all(...p));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET available remnants that can fit a piece (w×h or rotated)
router.get('/fit', (req, res) => {
  try {
    const { w, h, thickness } = req.query;
    if (!w || !h || !thickness) return res.status(400).json({ error: 'w,h,thickness required' });
    const pw = +w, ph = +h, pt = +thickness;
    const rows = db.prepare(
      "SELECT * FROM remnants WHERE status='available' AND thickness=? ORDER BY sqm ASC"
    ).all(pt);
    // Filter: piece fits normal or rotated (with 2mm tolerance)
    const fits = rows.filter(r =>
      (r.w >= pw-2 && r.h >= ph-2) || (r.w >= ph-2 && r.h >= pw-2)
    );
    res.json(fits);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/', (req, res) => {
  try {
    const { w, h, thickness, glass_type, color, brand, origin, opt_file_id, opt_file_name,
            raw_sheet_id, raw_sheet_label, slot_id, slot_code, notes,
            family, pattern, source, session_id, parent_remnant_id, qty } = req.body;
    if (!w || !h || !thickness) return res.status(400).json({ error: 'w,h,thickness required' });
    const n = Math.max(1, Math.min(50, +qty || 1));
    const src = source || (opt_file_id ? 'optimization' : 'manual');
    const sqm = (w * h) / 1000000;
    const created = [];
    const tx = db.transaction(() => {
      for (let i = 0; i < n; i++) {
        const uid = genUid(+thickness, color||'clear', brand||'', origin||'');
        const r = db.prepare(`INSERT INTO remnants
          (uid,w,h,thickness,glass_type,color,sqm,opt_file_id,opt_file_name,
           raw_sheet_id,raw_sheet_label,brand,origin,slot_id,slot_code,notes,
           family,pattern,source,session_id,parent_remnant_id,created_by)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          uid, +w, +h, +thickness, glass_type||'glass', color||'clear', sqm,
          opt_file_id||null, opt_file_name||null, raw_sheet_id||null, raw_sheet_label||null,
          brand||null, origin||null, slot_id||null, slot_code||null, notes||'',
          (family||'float'), (pattern||null), src, session_id||null, parent_remnant_id||null,
          req.user.name);
        db.prepare('INSERT INTO remnant_log (remnant_id,action,note,worker_id,worker_name) VALUES (?,?,?,?,?)')
          .run(r.lastInsertRowid, 'created', src==='optimization' ? ('From opt: '+(opt_file_name||'')) : 'Manual add', req.user.id, req.user.name);
        created.push(db.prepare('SELECT * FROM remnants WHERE id=?').get(r.lastInsertRowid));
        if (session_id) db.prepare('UPDATE remnant_sessions SET remnant_count=remnant_count+1 WHERE id=?').run(session_id);
      }
    });
    tx();
    res.status(201).json(n===1 ? created[0] : created);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id', (req, res) => {
  try {
    const { slot_id, slot_code, status, notes, w, h, family, pattern, color, thickness } = req.body;
    const rem = db.prepare('SELECT * FROM remnants WHERE id=?').get(+req.params.id);
    if (!rem) return res.status(404).json({ error: 'Not found' });
    db.prepare(`UPDATE remnants SET slot_id=?,slot_code=?,status=?,notes=?,w=?,h=?,
      sqm=?,family=?,pattern=?,color=?,thickness=? WHERE id=?`).run(
      slot_id??rem.slot_id, slot_code??rem.slot_code,
      status??rem.status, notes??rem.notes,
      w??rem.w, h??rem.h, ((w??rem.w)*(h??rem.h))/1000000,
      family??rem.family, pattern!==undefined?pattern:rem.pattern,
      color??rem.color, thickness??rem.thickness,
      +req.params.id
    );
    const changed=['slot_id','slot_code','status','notes','w','h','family','pattern','color','thickness']
      .filter(k=>req.body[k]!==undefined && String(req.body[k])!==String(rem[k]));
    if (changed.length) db.prepare('INSERT INTO remnant_log (remnant_id,action,note,worker_id,worker_name) VALUES (?,?,?,?,?)')
      .run(+req.params.id, 'edited', 'Changed: '+changed.join(','), req.user.id, req.user.name);
    res.json(db.prepare('SELECT * FROM remnants WHERE id=?').get(+req.params.id));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /:id/use — mark remnant as used for an order piece
router.post('/:id/use', (req, res) => {
  try {
    const { order_id, order_num, piece_uid, used_at } = req.body;
    const usedDate = used_at || "datetime('now')";
    db.prepare(`UPDATE remnants SET status='used',
      used_at=COALESCE(?,datetime('now')),
      used_for_order=?, used_for_piece=?, used_by_worker=? WHERE id=?`)
      .run(used_at||null, order_num||null, piece_uid||null, req.user.name, +req.params.id);
    db.prepare('INSERT INTO remnant_log (remnant_id,action,order_id,order_num,piece_uid,worker_id,worker_name) VALUES (?,?,?,?,?,?,?)')
      .run(+req.params.id, 'used', order_id||null, order_num||null, piece_uid||null, req.user.id, req.user.name);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /:id (discard)
router.delete('/:id', (req, res) => {
  try {
    db.prepare("UPDATE remnants SET status='discarded', discarded_at=datetime('now','localtime'), discarded_by=? WHERE id=?")
      .run(req.user.name, +req.params.id);
    db.prepare('INSERT INTO remnant_log (remnant_id,action,worker_id,worker_name) VALUES (?,?,?,?)')
      .run(+req.params.id, 'discarded', req.user.id, req.user.name);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /stats
router.get('/stats', (req, res) => {
  try {
    const stats = db.prepare(`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status='available' THEN 1 ELSE 0 END) AS available,
      SUM(CASE WHEN status='used' THEN 1 ELSE 0 END) AS used,
      SUM(CASE WHEN status='available' THEN sqm ELSE 0 END) AS available_sqm,
      SUM(CASE WHEN status='used' THEN sqm ELSE 0 END) AS used_sqm
    FROM remnants`).get();
    res.json(stats);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /log — factory-wide remnant activity log, joined with remnants for UID
// and dimensions. Supports filters: from, to (YYYY-MM-DD inclusive), action,
// worker, q (free-text). Returns up to 1000 rows newest-first by default.
//
// IMPORTANT: this route MUST be declared before '/:id/log' otherwise Express
// will match '/log' against ':id' (treating "log" as a remnant id).
router.get('/log', (req, res) => {
  try {
    const { from, to, action, worker, q, limit } = req.query;
    let sql = `
      SELECT
        rl.id, rl.remnant_id, rl.action, rl.note, rl.worker_name,
        rl.order_id, rl.order_num, rl.piece_uid, rl.ts,
        r.uid, r.w, r.h, r.thickness, r.glass_type, r.color, r.brand,
        r.slot_code, r.status
      FROM remnant_log rl
      LEFT JOIN remnants r ON r.id = rl.remnant_id
      WHERE 1=1
    `;
    const p = [];
    if (from)   { sql += ' AND rl.ts >= ?';       p.push(from); }
    if (to)     { sql += ' AND rl.ts <  date(?, "+1 day")'; p.push(to); } // inclusive
    if (action) { sql += ' AND rl.action = ?';    p.push(action); }
    if (worker) { sql += ' AND rl.worker_name = ?'; p.push(worker); }
    if (q && q.trim()) {
      sql += ` AND (
        COALESCE(r.uid,'')          LIKE ? OR
        COALESCE(rl.order_num,'')   LIKE ? OR
        COALESCE(rl.piece_uid,'')   LIKE ? OR
        COALESCE(rl.note,'')        LIKE ? OR
        COALESCE(rl.worker_name,'') LIKE ?
      )`;
      const lk = '%' + q.trim() + '%';
      p.push(lk, lk, lk, lk, lk);
    }
    sql += ' ORDER BY rl.ts DESC, rl.id DESC LIMIT ?';
    p.push(Math.min(+limit || 1000, 5000));
    res.json(db.prepare(sql).all(...p));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /log/workers — distinct worker names in remnant_log, for filter dropdown
router.get('/log/workers', (req, res) => {
  try {
    const rows = db.prepare(
      "SELECT DISTINCT worker_name FROM remnant_log WHERE worker_name IS NOT NULL AND worker_name <> '' ORDER BY worker_name"
    ).all();
    res.json(rows.map(r => r.worker_name));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /:id/log — single remnant's history (used by the per-row History modal)
router.get('/:id/log', (req, res) => {
  try {
    res.json(db.prepare('SELECT * FROM remnant_log WHERE remnant_id=? ORDER BY ts').all(+req.params.id));
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ?? R1: sessions, consume, move, open-orders-fit ??????????????????????????
router.post('/sessions', (req, res) => {
  try {
    const { thickness, glass_type, family, color, pattern, raw_sheet_id, raw_sheet_label, slot_id, slot_code } = req.body;
    if (!thickness) return res.status(400).json({ error: 'thickness required' });
    const r = db.prepare(`INSERT INTO remnant_sessions
      (worker_id, worker_name, thickness, glass_type, family, color, pattern, raw_sheet_id, raw_sheet_label, slot_id, slot_code)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      req.user.id, req.user.name, +thickness, glass_type||'glass', family||'float', color||'clear',
      pattern||null, raw_sheet_id||null, raw_sheet_label||null, slot_id||null, slot_code||null);
    res.status(201).json(db.prepare('SELECT * FROM remnant_sessions WHERE id=?').get(r.lastInsertRowid));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/sessions', (req, res) => {
  try { res.json(db.prepare('SELECT * FROM remnant_sessions ORDER BY id DESC LIMIT 100').all()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/sessions/:id/end', (req, res) => {
  try {
    db.prepare("UPDATE remnant_sessions SET ended_at=datetime('now','localtime') WHERE id=?").run(+req.params.id);
    res.json(db.prepare('SELECT * FROM remnant_sessions WHERE id=?').get(+req.params.id));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// consume: mark used for one-or-many pieces; optionally create child remnants
router.post('/:id/consume', (req, res) => {
  try {
    const remId = +req.params.id;
    const rem = db.prepare('SELECT * FROM remnants WHERE id=?').get(remId);
    if (!rem) return res.status(404).json({ error: 'Not found' });
    if (rem.status !== 'available') return res.status(400).json({ error: 'Remnant is '+rem.status });
    const pieces = Array.isArray(req.body.pieces) ? req.body.pieces : [];
    const children = Array.isArray(req.body.children) ? req.body.children : (req.body.child ? [req.body.child] : []);
    if (!pieces.length) return res.status(400).json({ error: 'pieces[] required' });
    const createdChildren = [];
    const tx = db.transaction(() => {
      db.prepare(`UPDATE remnants SET status='used', used_at=datetime('now','localtime'),
        used_for_order=?, used_for_piece=?, used_by_worker=? WHERE id=?`)
        .run(pieces[0].order_num||null, pieces.map(p=>p.piece_uid).filter(Boolean).join(', ').slice(0,200), req.user.name, remId);
      pieces.forEach(p => {
        db.prepare(`INSERT INTO remnant_log (remnant_id,action,order_id,order_num,piece_uid,worker_id,worker_name)
          VALUES (?,?,?,?,?,?,?)`)
          .run(remId, 'consume', p.order_id||null, p.order_num||null, p.piece_uid||null, req.user.id, req.user.name);
      });
      children.forEach(c => {
        if (!c || !c.w || !c.h) return;
        const uid = genUid(+rem.thickness, rem.color||'clear', rem.brand||'', rem.origin||'');
        const csqm = (c.w * c.h) / 1000000;
        const r = db.prepare(`INSERT INTO remnants
          (uid,w,h,thickness,glass_type,color,sqm,raw_sheet_id,raw_sheet_label,brand,origin,
           slot_id,slot_code,notes,family,pattern,source,parent_remnant_id,created_by)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          uid, +c.w, +c.h, rem.thickness, rem.glass_type, rem.color, csqm,
          rem.raw_sheet_id, rem.raw_sheet_label, rem.brand, rem.origin,
          c.slot_id||rem.slot_id||null, c.slot_code||rem.slot_code||null,
          'Child of '+rem.uid, rem.family||'float', rem.pattern||null, 'manual', remId, req.user.name);
        db.prepare('INSERT INTO remnant_log (remnant_id,action,note,worker_id,worker_name) VALUES (?,?,?,?,?)')
          .run(r.lastInsertRowid, 'created', 'Child of '+rem.uid, req.user.id, req.user.name);
        createdChildren.push(db.prepare('SELECT * FROM remnants WHERE id=?').get(r.lastInsertRowid));
      });
    });
    tx();
    res.json({ ok:true, consumed: pieces.length, children: createdChildren });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id/move', (req, res) => {
  try {
    const rem = db.prepare('SELECT * FROM remnants WHERE id=?').get(+req.params.id);
    if (!rem) return res.status(404).json({ error: 'Not found' });
    const { slot_id, slot_code } = req.body;
    db.prepare('UPDATE remnants SET slot_id=?, slot_code=? WHERE id=?').run(slot_id||null, slot_code||null, +req.params.id);
    db.prepare('INSERT INTO remnant_log (remnant_id,action,note,worker_id,worker_name) VALUES (?,?,?,?,?)')
      .run(+req.params.id, 'moved', 'From '+(rem.slot_code||'-')+' to '+(slot_code||'-'), req.user.id, req.user.name);
    res.json(db.prepare('SELECT * FROM remnants WHERE id=?').get(+req.params.id));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// open orders with pieces matching this remnant's identity AND fitting its dimensions
router.get('/open-orders-fit', (req, res) => {
  try {
    const rem = db.prepare('SELECT * FROM remnants WHERE id=?').get(+req.query.remnant_id);
    if (!rem) return res.status(404).json({ error: 'Remnant not found' });
    const rf = String(rem.family||'float').toLowerCase(), rp = String(rem.pattern||'').toLowerCase();
    const RW = rem.w, RH = rem.h;
    const orders = db.prepare(`SELECT id, num, customer_id, status, date FROM orders
      WHERE status NOT IN ('done','cancelled') ORDER BY id DESC`).all();
    const out = [];
    orders.forEach(o => {
      const items = db.prepare(`SELECT id, code, w, h, qty, thickness, glass_type, color, family, pattern, piece_uids
        FROM order_items WHERE order_id=?`).all(o.id);
      const fit = items.filter(it =>
        Number(it.thickness) === Number(rem.thickness) &&
        String(it.glass_type||'glass').toLowerCase() === String(rem.glass_type||'glass').toLowerCase() &&
        String(it.family||'float').toLowerCase() === rf &&
        String(it.pattern||'').toLowerCase() === rp &&
        ((it.w <= RW && it.h <= RH) || (it.h <= RW && it.w <= RH))
      ).map(it => { let u=[]; try{ u=JSON.parse(it.piece_uids||'[]'); }catch(e){} return Object.assign({}, it, { piece_uids: u }); });
      if (fit.length) out.push({ order_id:o.id, order_num:o.num, customer_id:o.customer_id, status:o.status, date:o.date, items: fit });
    });
    res.json({ remnant: rem, orders: out });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
