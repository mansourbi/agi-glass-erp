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
    db.prepare('UPDATE remnant_slots SET code=?,description=?,active=? WHERE id=?')
      .run(code?.trim().toUpperCase(), description||'', active===false?0:1, +req.params.id);
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
    const { status, thickness, color, slot_id } = req.query;
    let sql = 'SELECT * FROM remnants WHERE 1=1';
    const p = [];
    if (status)    { sql += ' AND status=?';    p.push(status); }
    if (thickness) { sql += ' AND thickness=?'; p.push(+thickness); }
    if (color)     { sql += ' AND color=?';     p.push(color); }
    if (slot_id)   { sql += ' AND slot_id=?';   p.push(+slot_id); }
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
            raw_sheet_id, raw_sheet_label, slot_id, slot_code, notes } = req.body;
    if (!w || !h || !thickness) return res.status(400).json({ error: 'w,h,thickness required' });
    const uid = genUid(+thickness, color||'clear', brand||'', origin||'');
    const sqm = (w * h) / 1000000;
    const r = db.prepare(`INSERT INTO remnants
      (uid,w,h,thickness,glass_type,color,sqm,opt_file_id,opt_file_name,
       raw_sheet_id,raw_sheet_label,brand,origin,slot_id,slot_code,notes)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      uid, +w, +h, +thickness, glass_type||'glass', color||'clear', sqm,
      opt_file_id||null, opt_file_name||null, raw_sheet_id||null, raw_sheet_label||null,
      brand||null, origin||null, slot_id||null, slot_code||null, notes||''
    );
    // Log creation
    db.prepare('INSERT INTO remnant_log (remnant_id,action,note,worker_id,worker_name) VALUES (?,?,?,?,?)')
      .run(r.lastInsertRowid, 'created', 'From opt: '+(opt_file_name||'manual'), req.user.id, req.user.name);
    res.status(201).json(db.prepare('SELECT * FROM remnants WHERE id=?').get(r.lastInsertRowid));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id', (req, res) => {
  try {
    const { slot_id, slot_code, status, notes, w, h } = req.body;
    const rem = db.prepare('SELECT * FROM remnants WHERE id=?').get(+req.params.id);
    if (!rem) return res.status(404).json({ error: 'Not found' });
    db.prepare(`UPDATE remnants SET slot_id=?,slot_code=?,status=?,notes=?,w=?,h=?,
      sqm=? WHERE id=?`).run(
      slot_id??rem.slot_id, slot_code??rem.slot_code,
      status??rem.status, notes??rem.notes,
      w??rem.w, h??rem.h, ((w??rem.w)*(h??rem.h))/1000000,
      +req.params.id
    );
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
router.delete('/:id', requireAdmin, (req, res) => {
  try {
    db.prepare("UPDATE remnants SET status='discarded' WHERE id=?").run(+req.params.id);
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

// GET /:id/log
router.get('/:id/log', (req, res) => {
  try {
    res.json(db.prepare('SELECT * FROM remnant_log WHERE remnant_id=? ORDER BY ts').all(+req.params.id));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
