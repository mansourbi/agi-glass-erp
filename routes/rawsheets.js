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
      'INSERT INTO raw_sheets (code,glass_type,color,thickness,w,h,company,origin,notes,stock_qty,family,pattern,is_virtual,pattern_any) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).run(code, gtype, color||'clear', +thickness, +w, +h, company||null, origin||null, notes||null, +stock_qty||0, (req.body.family||'float'), (req.body.pattern||null), (+req.body.is_virtual?1:0), (+req.body.pattern_any?1:0));
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
      `UPDATE raw_sheets SET code=?,glass_type=?,color=?,thickness=?,w=?,h=?,company=?,origin=?,notes=?,stock_qty=?,family=COALESCE(?,family),pattern=CASE WHEN ? IS NULL THEN pattern ELSE NULLIF(?, '') END,is_virtual=COALESCE(?,is_virtual),pattern_any=COALESCE(?,pattern_any),updated_at=datetime('now') WHERE id=?`
    ).run(code, gtype, color||'clear', +thickness, +w, +h, company||null, origin||null, notes||null, +stock_qty||0, (req.body.family!==undefined?(req.body.family||'float'):null), (req.body.pattern!==undefined?String(req.body.pattern||''):null), (req.body.pattern!==undefined?String(req.body.pattern||''):null), (req.body.is_virtual!==undefined?(+req.body.is_virtual?1:0):null), (req.body.pattern_any!==undefined?(+req.body.pattern_any?1:0):null), +req.params.id);
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
    if (!['sale','adjustment','purchase'].includes(type)) return res.status(400).json({ error: 'Invalid type' });
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

// DELETE /api/rawsheets/transactions/:txId — delete any transaction
router.delete('/transactions/:txId', requireAdmin, (req, res) => {
  try {
    const tx = db.prepare('SELECT * FROM raw_sheet_transactions WHERE id=?').get(+req.params.txId);
    if (!tx) return res.status(404).json({ error: 'Not found' });
    db.prepare('DELETE FROM raw_sheet_transactions WHERE id=?').run(+req.params.txId);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({error:e.message}); }
});

// PUT /api/rawsheets/transactions/:txId — edit any transaction (qty, date, sheet_id, notes)
router.put('/transactions/:txId', requireAdmin, (req, res) => {
  try {
    const tx = db.prepare('SELECT * FROM raw_sheet_transactions WHERE id=?').get(+req.params.txId);
    if (!tx) return res.status(404).json({ error: 'Not found' });
    const { sheet_id, qty, date, notes } = req.body;
    db.prepare(`UPDATE raw_sheet_transactions SET
      sheet_id = COALESCE(?, sheet_id),
      qty      = COALESCE(?, qty),
      date     = COALESCE(?, date),
      notes    = COALESCE(?, notes)
      WHERE id = ?`
    ).run(
      sheet_id != null ? +sheet_id : null,
      qty      != null ? +qty      : null,
      date     || null,
      notes    != null ? notes     : null,
      +req.params.txId
    );
    res.json(db.prepare('SELECT * FROM raw_sheet_transactions WHERE id=?').get(+req.params.txId));
  } catch(e) { res.status(500).json({error:e.message}); }
});

// POST /api/rawsheets/record-optimization — called when opt is marked done
router.post('/record-optimization', requireAdmin, (req, res) => {
  try {
    const { sheet_id, opt_file_id, opt_name, sheets_used, date } = req.body;
    if (!sheet_id || !sheets_used) return res.status(400).json({ error: 'sheet_id and sheets_used required' });
    // Dedup per (opt_file_id, sheet_id): a same-size split records one row PER
    // raw sheet for the same optimization, so the guard must include sheet_id —
    // otherwise the 2nd sheet of a split is wrongly skipped as a duplicate.
    const existing = db.prepare("SELECT id FROM raw_sheet_transactions WHERE type='optimization_use' AND ref_id=? AND sheet_id=?").get(+opt_file_id, +sheet_id);
    if (existing) return res.json({ ok: true, skipped: true });
    const r = db.prepare(`INSERT INTO raw_sheet_transactions (sheet_id,type,qty,ref_id,ref_label,date,notes) VALUES (?,?,?,?,?,?,?)`)
      .run(+sheet_id, 'optimization_use', -Math.abs(+sheets_used), +opt_file_id, opt_name||('Opt #'+opt_file_id),
        date||new Date().toISOString().slice(0,10), 'Optimization completed');
    res.status(201).json(db.prepare('SELECT * FROM raw_sheet_transactions WHERE id=?').get(r.lastInsertRowid));
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ── Runout forecast report ──────────────────────────────────────────────
// Buckets by Type+Family+Color+Pattern+Thickness; usage = optimization_use
// only (adjustments are corrections, not demand); فضل (customer-owned)
// sheets excluded from stock AND usage; pending opts shown as reserved.
router.get('/runout-report', (req, res) => {
  try{
    const normPat = t => { t = String(t||'').trim().toLowerCase(); if(t==='\u0641\u0644\u0648\u062a\u062f'||t==='\u0641\u0644') t='fluted'; return t||null; };
    const isFadl = r => /\u0641\u0636\u0644/.test(String(r.code||'')+String(r.notes||''));
    const sheets = db.prepare('SELECT * FROM raw_sheets').all().filter(r=>!r.is_virtual && !isFadl(r));
    const fadlIds = new Set(db.prepare('SELECT id, code, notes FROM raw_sheets').all().filter(isFadl).map(r=>r.id));
    const byId = Object.fromEntries(sheets.map(r=>[r.id, r]));
    const key = r => [r.glass_type||'glass', r.family||'float', r.color||'clear', normPat(r.pattern)||'-', r.thickness].join('|');

    // month windows: 3 full months + current MTD
    const now = new Date();
    const ym = d => d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');
    const months = [];
    for(let i=3;i>=1;i--){ months.push(ym(new Date(now.getFullYear(), now.getMonth()-i, 1))); }
    const mtd = ym(now);

    const buckets = {};
    const bk = r => {
      const k = key(r);
      if(!buckets[k]) buckets[k] = { type:r.glass_type||'glass', family:r.family||'float', color:r.color||'clear',
        pattern: normPat(r.pattern), thickness:r.thickness, sizes:{}, stock_sheets:0, stock_sqm:0,
        usage:Object.fromEntries([...months, mtd].map(m=>[m,{sheets:0,sqm:0}])), reserved_sheets:0, reserved_sqm:0 };
      return buckets[k];
    };
    // stock
    const balStmt = db.prepare('SELECT COALESCE(SUM(qty),0) b FROM raw_sheet_transactions WHERE sheet_id=?');
    sheets.forEach(r=>{
      const b = bk(r); const bal = balStmt.get(r.id).b; const sqm = r.w*r.h/1e6;
      b.stock_sheets += bal; b.stock_sqm += bal*sqm;
      const sz = r.w+'x'+r.h; b.sizes[sz] = (b.sizes[sz]||0)+bal;
    });
    // usage per month (optimization_use only, non-fadl, fadl text net on tx too)
    const from = months[0]+'-01';
    const tx = db.prepare("SELECT sheet_id, qty, date, ref_label, notes FROM raw_sheet_transactions WHERE type='optimization_use' AND date>=?").all(from);
    tx.forEach(t=>{
      if(fadlIds.has(t.sheet_id)) return;
      if(/\u0641\u0636\u0644/.test(String(t.ref_label||'')+String(t.notes||''))) return;
      const r = byId[t.sheet_id]; if(!r) return;
      const m = String(t.date||'').slice(0,7);
      const b = bk(r); const slot = b.usage[m]; if(!slot) return;
      const used = -t.qty; if(used<=0) return;
      slot.sheets += used; slot.sqm += used*(r.w*r.h/1e6);
    });
    // reserved: pending opts' result sheets
    try{
      db.prepare("SELECT id, results FROM opt_files WHERE status='pending'").all().forEach(of=>{
        let res2; try{ res2 = JSON.parse(of.results); }catch(e){ return; }
        (res2 && res2.results || []).forEach(sh=>{
          const sid = sh && sh.sh && sh.sh.id; if(!sid || fadlIds.has(sid)) return;
          const r = byId[sid]; if(!r) return;
          const b = bk(r); b.reserved_sheets += 1; b.reserved_sqm += r.w*r.h/1e6;
        });
      });
    }catch(e){}
    // finalize
    const rows = Object.values(buckets).map(b=>{
      const avgS = months.reduce((a,m)=>a+b.usage[m].sheets,0)/months.length;
      const avgQ = months.reduce((a,m)=>a+b.usage[m].sqm,0)/months.length;
      const effStock = b.stock_sqm - b.reserved_sqm;
      const runout = avgQ>0 ? effStock/avgQ : null;
      let runout_date = null;
      if(runout!=null && runout>=0){ const d=new Date(); d.setDate(d.getDate()+Math.round(runout*30.44)); runout_date=d.toISOString().slice(0,10); }
      return { ...b, sizes:Object.entries(b.sizes).filter(([,q])=>q>0).map(([s2,q])=>s2+' ('+q+')').join(', '),
        stock_sqm:+b.stock_sqm.toFixed(1), reserved_sqm:+b.reserved_sqm.toFixed(1),
        avg_month_sheets:+avgS.toFixed(1), avg_month_sqm:+avgQ.toFixed(1),
        runout_months: runout!=null?+runout.toFixed(2):null, runout_date };
    }).filter(b=>b.stock_sheets>0 || b.avg_month_sqm>0 || b.reserved_sheets>0);
    rows.sort((a,b2)=>{
      const ra=a.runout_months==null?1e9:a.runout_months, rb=b2.runout_months==null?1e9:b2.runout_months;
      return ra-rb;
    });
    res.json({ months, mtd, generated: new Date().toISOString(), fadl_excluded_sheets: fadlIds.size, rows });
  }catch(e){ res.status(500).json({error:e.message}); }
});

module.exports = router;
