// routes/deliveries.js — Delivery management
const router = require('express').Router();
const db     = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
router.use(requireAuth);

// ── Schema ────────────────────────────────────────────────────────────────
try {
  db.prepare(`CREATE TABLE IF NOT EXISTS receivers (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    company     TEXT DEFAULT '',
    phone       TEXT DEFAULT '',
    active      INTEGER DEFAULT 1,
    created_at  DATETIME DEFAULT (datetime('now','localtime'))
  )`).run();

  db.prepare(`CREATE TABLE IF NOT EXISTS deliveries (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    serial           TEXT NOT NULL UNIQUE,
    customer_id      INTEGER,
    customer_code    TEXT,
    customer_name    TEXT,
    receiver_id      INTEGER,
    receiver_name    TEXT,
    receiver_company TEXT,
    status           TEXT NOT NULL DEFAULT 'open',
    notes            TEXT DEFAULT '',
    created_by       INTEGER,
    created_by_name  TEXT,
    finalised_at     DATETIME,
    created_at       DATETIME DEFAULT (datetime('now','localtime'))
  )`).run();

  db.prepare(`CREATE TABLE IF NOT EXISTS delivery_items (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    delivery_id   INTEGER NOT NULL REFERENCES deliveries(id),
    piece_code    TEXT NOT NULL,
    piece_uid     TEXT NOT NULL,
    order_id      INTEGER,
    order_num     TEXT,
    customer_id   INTEGER,
    customer_code TEXT,
    w             REAL,
    h             REAL,
    thickness     REAL,
    glass_type    TEXT,
    color         TEXT,
    processes     TEXT DEFAULT '[]',
    added_by      INTEGER,
    added_by_name TEXT,
    added_at      DATETIME DEFAULT (datetime('now','localtime')),
    UNIQUE(delivery_id, piece_uid)
  )`).run();
} catch(e) { console.warn('[deliveries init]', e.message); }

try { db.prepare('ALTER TABLE delivery_items ADD COLUMN piece_code TEXT').run(); } catch(e) {}

// ── Helpers ───────────────────────────────────────────────────────────────
function genSerial(customerId, customerCode) {
  const n = db.prepare("SELECT COUNT(*) AS c FROM deliveries WHERE customer_id=?").get(customerId).c + 1;
  return customerCode + '-D' + n;
}
function genPieceCode(deliveryId, deliverySerial) {
  const n = db.prepare("SELECT COUNT(*) AS c FROM delivery_items WHERE delivery_id=?").get(deliveryId).c + 1;
  return deliverySerial + '-' + n;
}
function parseItems(rows) {
  return rows.map(i => ({ ...i, processes: JSON.parse(i.processes || '[]') }));
}
function parseDelivery(d) {
  const items = db.prepare('SELECT * FROM delivery_items WHERE delivery_id=? ORDER BY id').all(d.id);
  return { ...d, items: parseItems(items) };
}

// ══ RECEIVERS ══════════════════════════════════════════════════════════════
router.get('/receivers', (req, res) => {
  try { res.json(db.prepare('SELECT * FROM receivers WHERE active=1 ORDER BY name').all()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
router.post('/receivers', requireAdmin, (req, res) => {
  try {
    const { name, company, phone } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'name required' });
    const r = db.prepare('INSERT INTO receivers (name,company,phone) VALUES (?,?,?)').run(name.trim(), company||'', phone||'');
    res.status(201).json(db.prepare('SELECT * FROM receivers WHERE id=?').get(r.lastInsertRowid));
  } catch(e) { res.status(500).json({ error: e.message }); }
});
router.put('/receivers/:id', requireAdmin, (req, res) => {
  try {
    const { name, company, phone, active } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'name required' });
    db.prepare('UPDATE receivers SET name=?,company=?,phone=?,active=? WHERE id=?').run(name.trim(), company||'', phone||'', active===false?0:1, +req.params.id);
    res.json(db.prepare('SELECT * FROM receivers WHERE id=?').get(+req.params.id));
  } catch(e) { res.status(500).json({ error: e.message }); }
});
router.delete('/receivers/:id', requireAdmin, (req, res) => {
  try { db.prepare('UPDATE receivers SET active=0 WHERE id=?').run(+req.params.id); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// ══ DELIVERIES ═════════════════════════════════════════════════════════════
router.get('/', (req, res) => {
  try {
    const { status, customer_id } = req.query;
    let sql = `SELECT d.*, (SELECT COUNT(*) FROM delivery_items WHERE delivery_id=d.id) AS piece_count FROM deliveries d WHERE 1=1`;
    const p = [];
    if (status)      { sql += ' AND d.status=?';      p.push(status); }
    if (customer_id) { sql += ' AND d.customer_id=?'; p.push(+customer_id); }
    sql += ' ORDER BY d.created_at DESC';
    res.json(db.prepare(sql).all(...p));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// MUST be before /:id
router.get('/by-piece/:uid', (req, res) => {
  try {
    const item = db.prepare(
      `SELECT di.*, d.serial, d.status, d.customer_name FROM delivery_items di
       JOIN deliveries d ON d.id=di.delivery_id WHERE di.piece_uid=? ORDER BY di.added_at DESC LIMIT 1`
    ).get(req.params.uid);
    res.json(item || null);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', (req, res) => {
  try {
    const d = db.prepare('SELECT * FROM deliveries WHERE id=?').get(+req.params.id);
    if (!d) return res.status(404).json({ error: 'Not found' });
    res.json(parseDelivery(d));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/', (req, res) => {
  try {
    const { customer_id, customer_code, customer_name } = req.body;
    if (!customer_id || !customer_code) return res.status(400).json({ error: 'customer_id and customer_code required' });
    const open = db.prepare("SELECT * FROM deliveries WHERE customer_id=? AND status='open'").get(+customer_id);
    if (open) return res.json(parseDelivery(open));
    const serial = genSerial(+customer_id, customer_code);
    const r = db.prepare(`INSERT INTO deliveries (serial,customer_id,customer_code,customer_name,status,created_by,created_by_name) VALUES (?,?,?,?,?,?,?)`)
      .run(serial, +customer_id, customer_code, customer_name||'', 'open', req.user.id, req.user.name);
    res.status(201).json(parseDelivery(db.prepare('SELECT * FROM deliveries WHERE id=?').get(r.lastInsertRowid)));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/items', (req, res) => {
  try {
    const delivery = db.prepare('SELECT * FROM deliveries WHERE id=?').get(+req.params.id);
    if (!delivery) return res.status(404).json({ error: 'Delivery not found' });
    if (delivery.status !== 'open') return res.status(400).json({ error: 'Delivery is already finalised' });
    const { piece_uid, order_id, order_num, customer_id, customer_code, w, h, thickness, glass_type, color, processes } = req.body;
    if (!piece_uid) return res.status(400).json({ error: 'piece_uid required' });
    const existing = db.prepare('SELECT id FROM delivery_items WHERE delivery_id=? AND piece_uid=?').get(+req.params.id, piece_uid);
    if (existing) return res.status(409).json({ error: 'Piece already in this delivery' });
    const piece_code = genPieceCode(+req.params.id, delivery.serial);
    const r = db.prepare(`INSERT INTO delivery_items (delivery_id,piece_code,piece_uid,order_id,order_num,customer_id,customer_code,w,h,thickness,glass_type,color,processes,added_by,added_by_name) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(+req.params.id, piece_code, piece_uid, order_id||null, order_num||null, customer_id||null, customer_code||null, +w||0, +h||0, +thickness||0, glass_type||'', color||'', JSON.stringify(processes||[]), req.user.id, req.user.name);
    const item = db.prepare('SELECT * FROM delivery_items WHERE id=?').get(r.lastInsertRowid);
    res.status(201).json({ ...item, processes: JSON.parse(item.processes||'[]') });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id/items/:pieceUid', (req, res) => {
  try {
    const delivery = db.prepare('SELECT * FROM deliveries WHERE id=?').get(+req.params.id);
    if (!delivery) return res.status(404).json({ error: 'Not found' });
    if (delivery.status !== 'open') return res.status(400).json({ error: 'Delivery already finalised' });
    db.prepare('DELETE FROM delivery_items WHERE delivery_id=? AND piece_uid=?').run(+req.params.id, req.params.pieceUid);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/finalise', (req, res) => {
  try {
    const { receiver_id, receiver_name, receiver_company, notes } = req.body;
    const delivery = db.prepare('SELECT * FROM deliveries WHERE id=?').get(+req.params.id);
    if (!delivery) return res.status(404).json({ error: 'Not found' });
    if (delivery.status !== 'open') return res.status(400).json({ error: 'Already finalised' });
    const items = db.prepare('SELECT id FROM delivery_items WHERE delivery_id=?').all(+req.params.id);
    if (!items.length) return res.status(400).json({ error: 'No pieces in delivery' });
    let rName = receiver_name || '';
    let rCompany = receiver_company || '';
    if (receiver_id) {
      const rec = db.prepare('SELECT * FROM receivers WHERE id=?').get(+receiver_id);
      if (rec) { rName = rec.name; rCompany = rec.company || ''; }
    }
    if (!rName) return res.status(400).json({ error: 'Receiver name required' });
    db.prepare(`UPDATE deliveries SET status='finalised', receiver_id=?, receiver_name=?, receiver_company=?, notes=?, finalised_at=datetime('now','localtime') WHERE id=?`)
      .run(receiver_id||null, rName, rCompany, notes||'', +req.params.id);
    res.json(parseDelivery(db.prepare('SELECT * FROM deliveries WHERE id=?').get(+req.params.id)));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/deliveries/:id — delete an open delivery and its items
router.delete('/:id', requireAdmin, (req, res) => {
  try {
    const delivery = db.prepare('SELECT * FROM deliveries WHERE id=?').get(+req.params.id);
    if (!delivery) return res.status(404).json({ error: 'Not found' });
    if (delivery.status === 'finalised')
      return res.status(400).json({ error: 'Cannot delete a finalised delivery' });
    db.prepare('DELETE FROM delivery_items WHERE delivery_id=?').run(+req.params.id);
    db.prepare('DELETE FROM deliveries WHERE id=?').run(+req.params.id);
    res.json({ ok: true, deleted: delivery.serial });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
