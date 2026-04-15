// routes/rawsheets.js
const router = require('express').Router();
const db     = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
router.use(requireAuth);

// ── Schema ────────────────────────────────────────────────────────────────
try {
  db.prepare(`CREATE TABLE IF NOT EXISTS raw_sheet_transactions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    sheet_id    INTEGER NOT NULL REFERENCES raw_sheets(id),
    type        TEXT NOT NULL,   -- opening | purchase | optimization_use | sale | adjustment
    qty         REAL NOT NULL,   -- positive = in, negative = out
    ref_id      INTEGER,         -- purchase_id or opt_file_id
    ref_label   TEXT DEFAULT '', -- human-readable reference
    buyer       TEXT DEFAULT '', -- for sales
    date        TEXT NOT NULL,
    notes       TEXT DEFAULT '',
    created_by  TEXT DEFAULT '',
    created_at  DATETIME DEFAULT (datetime('now','localtime'))
  )`).run();
} catch(e) { console.warn('[raw_sheet_transactions init]', e.message); }

// ── Backfill: run once to seed existing data into transactions ────────────
try {
  const alreadySeeded = db.prepare("SELECT COUNT(*) AS c FROM raw_sheet_transactions").get().c;
  if (alreadySeeded === 0) {
    const sheets = db.prepare('SELECT * FROM raw_sheets').all();
    const insT = db.prepare(`INSERT INTO raw_sheet_transactions (sheet_id,type,qty,ref_id,ref_label,date,notes) VALUES (?,?,?,?,?,?,?)`);

    const backfill = db.transaction(() => {
      for (const sh of sheets) {
        // Opening stock from stock_qty
        if (sh.stock_qty > 0) {
          insT.run(sh.id, 'opening', sh.stock_qty, null, 'Opening stock', sh.created_at?.slice(0,10)||new Date().toISOString().slice(0,10), 'Migrated from stock_qty');
        }
      }
      // Purchases
      const purchases = db.prepare('SELECT * FROM purchases ORDER BY date').all();
      for (const p of purchases) {
        insT.run(p.sheet_id, 'purchase', p.qty, p.id, 'Purchase #'+p.id, p.date, p.notes||'');
      }
      // Completed optimizations
      const opts = db.prepare("SELECT * FROM opt_files WHERE status='done'").all();
      for (const f of opts) {
        if (!f.raw_sheet_id) continue;
        let sheetsUsed = 1;
        try {
          const results = typeof f.results === 'string' ? JSON.parse(f.results) : f.results;
          const arr = Array.isArray(results) ? results : (results?.results || []);
          sheetsUsed = arr.length || 1;
        } catch(e) {}
        const label = f.name || ('Opt #' + f.id);
        const date  = (f.completed_at || f.created_at || '').slice(0,10) || new Date().toISOString().slice(0,10);
        insT.run(f.raw_sheet_id, 'optimization_use', -sheetsUsed, f.id, label, date, 'Auto: optimization completed');
      }
    });
    backfill();
    console.log('[rawsheets] Backfill complete');
  }
} catch(e) { console.warn('[rawsheets backfill]', e.message); }

// ── Helpers ───────────────────────────────────────────────────────────────
function normalize(row) { return { ...row, type: row.glass_type }; }

function getBalance(sheetId) {
  const r = db.prepare("SELECT COALESCE(SUM(qty),0) AS bal FROM raw_sheet_transactions WHERE sheet_id=?").get(sheetId);
  return r ? r.bal : 0;
}

// ── Raw sheets CRUD ───────────────────────────────────────────────────────
router.get('/', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM raw_sheets ORDER BY thickness,glass_type,color').all();
    res.json(rows.map(r => ({ ...normalize(r), balance: getBalance(r.id) })));
  } catch(e) { res.status(500).json({error:e.message}); }
});

router.post('/', requireAdmin, (req, res) => {
  try {
    const { code, glass_type, type, color, thickness, w, h, company, origin, notes, stock_qty } = req.body;
    const gtype = glass_type || type || 'glass';
    const r = db.prepare(
      'INSERT INTO raw_sheets (code,glass_type,color,thickness,w,h,company,origin,notes,stock_qty) VALUES (?,?,?,?,?,?,?,?,?,?)'
    ).run(code, gtype, color||'clear', +thickness, +w, +h, company||null, origin||null, notes||null, +stock_qty||0);
    const row = db.prepare('SELECT * FROM raw_sheets WHERE id=?').get(r.lastInsertRowid);
    // Create opening transaction if stock_qty > 0
    if (+stock_qty > 0) {
      db.prepare(`INSERT INTO raw_sheet_transactions (sheet_id,type,qty,ref_label,date,notes) VALUES (?,?,?,?,?,?)`)
        .run(r.lastInsertRowid, 'opening', +stock_qty, 'Opening stock', new Date().toISOString().slice(0,10), 'Added with sheet');
    }
    res.status(201).json({ ...normalize(row), balance: getBalance(r.lastInsertRowid) });
  } catch(e) { res.status(500).json({error:e.message}); }
});

router.put('/:id', requireAdmin, (req, res) => {
  try {
    const { code, glass_type, type, color, thickness, w, h, company, origin, notes, stock_qty } = req.body;
    const gtype = glass_type || type || 'glass';
    db.prepare(
      `UPDATE raw_sheets SET code=?,glass_type=?,color=?,thickness=?,w=?,h=?,company=?,origin=?,notes=?,stock_qty=?,updated_at=datetime('now') WHERE id=?`
    ).run(code, gtype, color||'clear', +thickness, +w, +h, company||null, origin||null, notes||null, +stock_qty||0, +req.params.id);
    const row = db.prepare('SELECT * FROM raw_sheets WHERE id=?').get(+req.params.id);
    res.status(200).json({ ...normalize(row), balance: getBalance(+req.params.id) });
  } catch(e) { res.status(500).json({error:e.message}); }
});

router.delete('/:id', requireAdmin, (req, res) => {
  try {
    db.prepare('DELETE FROM raw_sheets WHERE id=?').run(+req.params.id);
    res.json({ok:true});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ── Transactions ──────────────────────────────────────────────────────────

// GET /api/rawsheets/:id/transactions — full ledger for one sheet
router.get('/:id/transactions', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM raw_sheet_transactions WHERE sheet_id=? ORDER BY date ASC, id ASC').all(+req.params.id);
    const balance = getBalance(+req.params.id);
    res.json({ balance, transactions: rows });
  } catch(e) { res.status(500).json({error:e.message}); }
});

// POST /api/rawsheets/:id/transactions — manual entry (sale, adjustment)
router.post('/:id/transactions', requireAdmin, (req, res) => {
  try {
    const { type, qty, buyer, date, notes } = req.body;
    if (!['sale','adjustment','purchase','opening'].includes(type)) return res.status(400).json({ error: 'Invalid type' });
    if (!qty || qty === 0) return res.status(400).json({ error: 'qty required' });
    if (!date) return res.status(400).json({ error: 'date required' });
    // For sales and outward adjustments, qty should be negative
    const signedQty = type === 'sale' ? -Math.abs(+qty) : +qty;
    const r = db.prepare(`INSERT INTO raw_sheet_transactions (sheet_id,type,qty,ref_label,buyer,date,notes,created_by) VALUES (?,?,?,?,?,?,?,?)`)
      .run(+req.params.id, type, signedQty,
        type==='sale' ? ('Sale to '+(buyer||'unknown')) : (type==='adjustment'?'Manual adjustment':'Purchase'),
        buyer||'', date, notes||'', req.user.name);
    res.status(201).json(db.prepare('SELECT * FROM raw_sheet_transactions WHERE id=?').get(r.lastInsertRowid));
  } catch(e) { res.status(500).json({error:e.message}); }
});

// DELETE /api/rawsheets/transactions/:txId — delete a manual transaction
router.delete('/transactions/:txId', requireAdmin, (req, res) => {
  try {
    const tx = db.prepare('SELECT * FROM raw_sheet_transactions WHERE id=?').get(+req.params.txId);
    if (!tx) return res.status(404).json({ error: 'Not found' });
    if (!['purchase','sale','adjustment','optimization_use'].includes(tx.type)) return res.status(400).json({ error: 'Can only delete purchase, sale or adjustment entries' });
    db.prepare('DELETE FROM raw_sheet_transactions WHERE id=?').run(+req.params.txId);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({error:e.message}); }
});

// POST /api/rawsheets/record-optimization — called when opt is marked done
router.post('/record-optimization', requireAdmin, (req, res) => {
  try {
    const { sheet_id, opt_file_id, opt_name, sheets_used, date } = req.body;
    if (!sheet_id || !sheets_used) return res.status(400).json({ error: 'sheet_id and sheets_used required' });
    // Check not already recorded
    const existing = db.prepare("SELECT id FROM raw_sheet_transactions WHERE type='optimization_use' AND ref_id=?").get(+opt_file_id);
    if (existing) return res.json({ ok: true, skipped: true });
    const r = db.prepare(`INSERT INTO raw_sheet_transactions (sheet_id,type,qty,ref_id,ref_label,date,notes) VALUES (?,?,?,?,?,?,?)`)
      .run(+sheet_id, 'optimization_use', -Math.abs(+sheets_used), +opt_file_id, opt_name||('Opt #'+opt_file_id),
        date||new Date().toISOString().slice(0,10), 'Optimization completed');
    res.status(201).json(db.prepare('SELECT * FROM raw_sheet_transactions WHERE id=?').get(r.lastInsertRowid));
  } catch(e) { res.status(500).json({error:e.message}); }
});

module.exports = router;






