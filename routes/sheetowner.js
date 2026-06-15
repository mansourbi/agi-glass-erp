// routes/sheetowner.js
// Raw-sheet ownership (supports the أجور / labor model).
// owner_customer_id: the customer who owns the glass (REF now). NULL = AGI-owned ("in-house").
const router = require('express').Router();
const db     = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
router.use(requireAuth);

// Idempotent migration + ONE-TIME default-to-REF backfill (runs only when the column is first added)
try {
  const cols = db.prepare("PRAGMA table_info(raw_sheets)").all().map(c => c.name);
  if (!cols.includes('owner_customer_id')) {
    db.prepare('ALTER TABLE raw_sheets ADD COLUMN owner_customer_id INTEGER').run();
    const ref = db.prepare("SELECT id FROM customers WHERE code='REF'").get();
    if (ref && ref.id) {
      const r = db.prepare('UPDATE raw_sheets SET owner_customer_id=? WHERE owner_customer_id IS NULL').run(ref.id);
      console.log('[sheetowner] backfilled ' + r.changes + ' sheets -> REF (id ' + ref.id + ')');
    } else {
      console.warn('[sheetowner] REF customer not found - sheets left unassigned');
    }
  }
} catch (e) { console.error('[sheetowner] migration', e.message); }

const fmtOwner = r => (r.owner_customer_id == null) ? 'AGI (in-house)' : (r.owner_name || r.owner_code || ('#' + r.owner_customer_id));

// GET /api/sheetowner  -> all sheets with owner
router.get('/', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT rs.id, rs.code, rs.owner_customer_id, c.name AS owner_name, c.code AS owner_code
      FROM raw_sheets rs LEFT JOIN customers c ON c.id = rs.owner_customer_id
      ORDER BY rs.code`).all();
    res.json(rows.map(r => ({ id: r.id, code: r.code, owner_customer_id: r.owner_customer_id, owner: fmtOwner(r) })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/sheetowner/:sheetId  -> one sheet's owner
router.get('/:sheetId', (req, res) => {
  try {
    const r = db.prepare(`
      SELECT rs.id, rs.code, rs.owner_customer_id, c.name AS owner_name, c.code AS owner_code
      FROM raw_sheets rs LEFT JOIN customers c ON c.id = rs.owner_customer_id WHERE rs.id=?`).get(+req.params.sheetId);
    if (!r) return res.status(404).json({ error: 'Sheet not found' });
    res.json({ id: r.id, code: r.code, owner_customer_id: r.owner_customer_id, owner: fmtOwner(r) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/sheetowner/bulk/set  { owner_customer_id, sheet_ids?:[] }  (null = AGI; no ids = ALL sheets)
router.post('/bulk/set', requireAdmin, (req, res) => {
  try {
    let owner = req.body.owner_customer_id;
    owner = (owner == null || owner === '') ? null : +owner;
    if (owner != null && !db.prepare('SELECT id FROM customers WHERE id=?').get(owner)) return res.status(404).json({ error: 'Customer not found' });
    const ids = Array.isArray(req.body.sheet_ids) ? req.body.sheet_ids.map(Number).filter(Boolean) : null;
    let changed = 0;
    if (ids && ids.length) {
      const stmt = db.prepare('UPDATE raw_sheets SET owner_customer_id=? WHERE id=?');
      db.transaction(list => { for (const i of list) changed += stmt.run(owner, i).changes; })(ids);
    } else {
      changed = db.prepare('UPDATE raw_sheets SET owner_customer_id=?').run(owner).changes;
    }
    res.json({ ok: true, changed });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/sheetowner/:sheetId  { owner_customer_id }  (null = AGI in-house)
router.post('/:sheetId', requireAdmin, (req, res) => {
  try {
    const id = +req.params.sheetId;
    if (!db.prepare('SELECT id FROM raw_sheets WHERE id=?').get(id)) return res.status(404).json({ error: 'Sheet not found' });
    let owner = req.body.owner_customer_id;
    owner = (owner == null || owner === '') ? null : +owner;
    if (owner != null && !db.prepare('SELECT id FROM customers WHERE id=?').get(owner)) return res.status(404).json({ error: 'Customer not found' });
    db.prepare('UPDATE raw_sheets SET owner_customer_id=? WHERE id=?').run(owner, id);
    const r = db.prepare(`
      SELECT rs.id, rs.code, rs.owner_customer_id, c.name AS owner_name, c.code AS owner_code
      FROM raw_sheets rs LEFT JOIN customers c ON c.id = rs.owner_customer_id WHERE rs.id=?`).get(id);
    res.json({ id: r.id, code: r.code, owner_customer_id: r.owner_customer_id, owner: fmtOwner(r) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;