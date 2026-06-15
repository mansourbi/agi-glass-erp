// routes/finalproducts.js
const router = require('express').Router();
const db     = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
router.use(requireAuth);

// Ensure table exists
try {
  db.prepare(`CREATE TABLE IF NOT EXISTS final_products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'زجاج',
    subtype TEXT DEFAULT '',
    thickness TEXT DEFAULT '',
    glass_type TEXT DEFAULT '',
    color TEXT DEFAULT '',
    tempered TEXT DEFAULT '',
    edge TEXT DEFAULT '',
    process TEXT DEFAULT '',
    paint_color TEXT DEFAULT '',
    brand TEXT DEFAULT '',
    origin TEXT DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT (datetime('now'))
  )`).run();
} catch(e) { console.warn('[final_products init]', e.message); }

// ── Schema migrations (idempotent): pricing & identity ──────────────────────
try { db.prepare("ALTER TABLE final_products ADD COLUMN serial TEXT").run(); } catch(e){}
try { db.prepare("ALTER TABLE final_products ADD COLUMN general_price_sqm REAL DEFAULT 0").run(); } catch(e){}
try { db.prepare("ALTER TABLE final_products ADD COLUMN spec_key TEXT").run(); } catch(e){}
try { db.prepare('ALTER TABLE orders ADD COLUMN final_product_id INTEGER').run(); } catch(e){}

// أجور (labor-only) flag — true => raw material NOT included; label gets the أجور prefix.
const fpCols = db.prepare("PRAGMA table_info(final_products)").all().map(c => c.name);
const ujoorIsNew = !fpCols.includes('is_ujoor');
if (ujoorIsNew) { try { db.prepare("ALTER TABLE final_products ADD COLUMN is_ujoor INTEGER DEFAULT 0").run(); } catch(e){ console.warn('[final_products] add is_ujoor', e.message); } }

const isUjoor = d => (d && (d.is_ujoor === 1 || d.is_ujoor === true || d.is_ujoor === '1'));

// Label from the 11 spec fields (same order the client uses); أجور prefix when labor-only
function buildLabel(d) {
  const parts = [d.category, d.subtype, d.thickness, d.glass_type, d.color,
    d.tempered, d.edge, d.process, d.paint_color, d.brand, d.origin];
  const base = parts.map(p => (p||'').trim()).filter(Boolean).join(' ');
  return (isUjoor(d) ? 'أجور ' : '') + base;
}
// Normalized uniqueness signature: ujoor flag + the SAME 11 fields (empties included).
// The ujoor flag is part of the key so an أجور product and its non-أجور twin coexist.
function specKey(d) {
  const parts = [d.category, d.subtype, d.thickness, d.glass_type, d.color,
    d.tempered, d.edge, d.process, d.paint_color, d.brand, d.origin];
  return (isUjoor(d) ? '1' : '0') + '|' +
    parts.map(p => (p==null?'':String(p)).trim().toLowerCase()).join('|');
}
const serialOf = id => 'FP-' + String(id).padStart(5,'0');

// ── One-time backfill of serial + spec_key for existing rows ────────────────
try {
  const rows = db.prepare('SELECT * FROM final_products').all();
  const setSerial = db.prepare('UPDATE final_products SET serial=? WHERE id=?');
  if (ujoorIsNew) {
    // is_ujoor is brand-new => every existing product currently uses customer-owned
    // (REF) glass, so all are أجور (labor). Mark them, re-prefix the label, and
    // recompute spec_key to the new ujoor-aware format. Runs exactly once.
    const updAll = db.prepare('UPDATE final_products SET is_ujoor=1, label=?, spec_key=? WHERE id=?');
    db.transaction(() => {
      for (const r of rows) {
        if (!r.serial) setSerial.run(serialOf(r.id), r.id);
        const d = { ...r, is_ujoor: 1 };
        updAll.run(buildLabel(d), specKey(d), r.id);
      }
    })();
    console.log('[final_products] marked ' + rows.length + ' existing products as أجور (labor)');
  } else {
    const setKey = db.prepare('UPDATE final_products SET spec_key=? WHERE id=?');
    db.transaction(() => {
      for (const r of rows) {
        if (!r.serial)          setSerial.run(serialOf(r.id), r.id);
        if (r.spec_key == null) setKey.run(specKey(r), r.id);
      }
    })();
  }
  const dupes = db.prepare('SELECT spec_key, COUNT(*) c FROM final_products GROUP BY spec_key HAVING c>1').all();
  if (dupes.length) console.warn('[final_products] pre-existing duplicate spec_keys:', dupes.length, '(new dupes still blocked by route check)');
} catch(e) { console.warn('[final_products backfill]', e.message); }

// Best-effort hard guard; the route-level check below is the reliable enforcement
try { db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_fp_speckey ON final_products(spec_key)').run(); }
catch(e){ console.warn('[final_products] unique index not created (existing dupes?):', e.message); }

function findDuplicate(key, exceptId) {
  return exceptId
    ? db.prepare('SELECT id,label,serial FROM final_products WHERE spec_key=? AND id<>?').get(key, exceptId)
    : db.prepare('SELECT id,label,serial FROM final_products WHERE spec_key=?').get(key);
}

// GET all
router.get('/', (req, res) => {
  try {
    res.json(db.prepare('SELECT * FROM final_products ORDER BY sort_order,category,label').all());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST create
router.post('/', requireAdmin, (req, res) => {
  try {
    const d = req.body;
    const label = d.label || buildLabel(d);
    const key   = specKey(d);
    const dup   = findDuplicate(key);
    if (dup) return res.status(409).json({ error: 'duplicate',
      message: 'A final product with these exact specs already exists', existing: dup });
    const price = +d.general_price_sqm || 0;
    const r = db.prepare(`INSERT INTO final_products
      (label,category,subtype,thickness,glass_type,color,tempered,edge,process,paint_color,brand,origin,sort_order,general_price_sqm,spec_key,is_ujoor)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      label, d.category||'زجاج', d.subtype||'', d.thickness||'',
      d.glass_type||'', d.color||'', d.tempered||'', d.edge||'',
      d.process||'', d.paint_color||'', d.brand||'', d.origin||'', d.sort_order||0,
      price, key, isUjoor(d)?1:0
    );
    db.prepare('UPDATE final_products SET serial=? WHERE id=?').run(serialOf(r.lastInsertRowid), r.lastInsertRowid);
    res.status(201).json(db.prepare('SELECT * FROM final_products WHERE id=?').get(r.lastInsertRowid));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT update (serial is immutable; general_price_sqm preserved if not sent)
router.put('/:id', requireAdmin, (req, res) => {
  try {
    const id = +req.params.id;
    const d  = req.body;
    const label = d.label || buildLabel(d);
    const key   = specKey(d);
    const dup   = findDuplicate(key, id);
    if (dup) return res.status(409).json({ error: 'duplicate',
      message: 'A final product with these exact specs already exists', existing: dup });
    const price = (d.general_price_sqm===undefined||d.general_price_sqm===null||d.general_price_sqm==='')
      ? null : (+d.general_price_sqm||0);
    db.prepare(`UPDATE final_products SET
      label=?,category=?,subtype=?,thickness=?,glass_type=?,color=?,tempered=?,edge=?,
      process=?,paint_color=?,brand=?,origin=?,active=?,sort_order=?,spec_key=?,is_ujoor=?,
      general_price_sqm=COALESCE(?,general_price_sqm) WHERE id=?`).run(
      label, d.category||'زجاج', d.subtype||'', d.thickness||'',
      d.glass_type||'', d.color||'', d.tempered||'', d.edge||'',
      d.process||'', d.paint_color||'', d.brand||'', d.origin||'',
      d.active===false?0:1, d.sort_order||0, key, isUjoor(d)?1:0, price, id
    );
    res.json(db.prepare('SELECT * FROM final_products WHERE id=?').get(id));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE
router.delete('/:id', requireAdmin, (req, res) => {
  try {
    db.prepare('DELETE FROM final_products WHERE id=?').run(+req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /stats — orders count/qty/sqm per final product
router.get('/stats', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT fp.id, fp.label, fp.category,
        COUNT(DISTINCT o.id) AS order_count,
        COALESCE(SUM(oi.qty),0) AS total_qty,
        COALESCE(SUM(oi.w*oi.h*oi.qty),0)/1000000.0 AS total_sqm
      FROM final_products fp
      LEFT JOIN orders o ON o.final_product_id=fp.id
      LEFT JOIN order_items oi ON oi.order_id=o.id
      GROUP BY fp.id ORDER BY fp.sort_order,fp.label
    `).all();
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
