// routes/purchasing.js — Purchasing & Cost-of-Goods system
//
// Core concepts:
//   • PURCHASE ORDERS: header for a single supplier transaction (local or international)
//   • PURCHASE ITEMS: line items on the PO, each with its own primary unit (sqm/m/kg/piece)
//   • PURCHASE COSTS: extras (shipping, clearance, transport, customs duty, customs VAT)
//   • RAW SHEET BATCHES: per-SKU receipt records — historical landed cost snapshots
//   • RAW SHEET COST HISTORY: WAC change log for every cost-changing event
//
// Cost flow:
//   1. User creates PO with items + extra costs (status='draft' or 'ordered')
//   2. User clicks "Receive" → server runs receivePurchaseOrder() in a single transaction:
//      a. Computes per-item landed-cost-per-unit-JOD (goods + allocated extras, ex-VAT)
//      b. Creates raw_sheet_batches row per item
//      c. Updates raw_sheets WAC (weighted average cost) per primary unit
//      d. Writes raw_sheet_transactions row(s) tagged with batch_id
//      e. Writes raw_sheet_cost_history rows for the audit log
//      f. Locks the PO (status='received', locked=1) — corrections via /:id/adjust
//
// Why VAT lives separately:
//   AGI Glass is VAT-registered (Scenario A) — input VAT is recoverable, NOT cost.
//   So COGS reports use line_subtotal_goods (ex-VAT) and amount_jod from extras,
//   while VAT amounts roll up into a separate "recoverable input VAT" total.
//
// Backwards compatibility:
//   The existing `purchases` table (25 rows of "Opening stock" notes) is left untouched
//   as a historical record. Going forward, all stock receipts flow through this module.
//   raw_sheets gains 3 cost columns; raw_sheet_transactions gains 3 cost-snapshot columns.

const router = require('express').Router();
const db     = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
router.use(requireAuth);

// ═══════════════════════════════════════════════════════════════════════════
// SCHEMA — runs at module load. Idempotent (CREATE IF NOT EXISTS + ALTER tries).
// ═══════════════════════════════════════════════════════════════════════════
try {
  // 1. Material categories — what kinds of things you buy
  db.prepare(`CREATE TABLE IF NOT EXISTS raw_material_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    primary_unit TEXT NOT NULL DEFAULT 'piece',  -- sqm | m | kg | piece | roll
    active INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT (datetime('now'))
  )`).run();
  // Seed default category for glass (only if empty)
  const catCount = db.prepare('SELECT COUNT(*) c FROM raw_material_categories').get().c;
  if (catCount === 0) {
    db.prepare(`INSERT INTO raw_material_categories (code, name, primary_unit, sort_order)
                VALUES (?,?,?,?)`).run('GLASS', 'Glass Sheets', 'sqm', 0);
  }

  // 1b. Suppliers — proper master table to avoid free-text spelling drift.
  // POs reference supplier_id; supplier_name/country on the PO are kept as
  // a denormalized snapshot (so historical POs survive renaming a supplier).
  db.prepare(`CREATE TABLE IF NOT EXISTS suppliers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    country TEXT DEFAULT '',
    default_currency TEXT DEFAULT 'JOD',
    contact_email TEXT DEFAULT '',
    contact_phone TEXT DEFAULT '',
    payment_terms TEXT DEFAULT '',          -- e.g. "Net 30", "50% advance"
    default_lead_time_days INTEGER,
    notes TEXT DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT (datetime('now')),
    created_by TEXT
  )`).run();

  // 1c. Manufacturers — who actually makes the raw materials (Guardian, XYG,
  // QIN, Majed Yacoub, etc.). Distinct from suppliers/vendors (who you pay).
  // Manufacturer is a property of the raw material itself; supplier is a
  // property of the transaction. A vendor can sell glass from many
  // manufacturers, and a manufacturer's products can be sold by many vendors.
  //
  // This table is referenced by raw_sheets.manufacturer_id and (in future)
  // by raw_paints.manufacturer_id, raw_films.manufacturer_id, etc. — so it
  // intentionally holds NO material-type-specific fields.
  db.prepare(`CREATE TABLE IF NOT EXISTS manufacturers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    country TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT (datetime('now')),
    created_by TEXT
  )`).run();

  // 2. Purchase orders — one per supplier transaction
  db.prepare(`CREATE TABLE IF NOT EXISTS purchase_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    po_number TEXT NOT NULL UNIQUE,
    purchase_type TEXT NOT NULL DEFAULT 'local',     -- 'local' | 'international'
    supplier_name TEXT NOT NULL,
    supplier_country TEXT DEFAULT '',
    order_date TEXT,                                  -- YYYY-MM-DD
    expected_arrival TEXT,
    actual_arrival TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
        -- draft | ordered | in_transit | received | cancelled
    locked INTEGER NOT NULL DEFAULT 0,                -- 1 once received

    goods_currency TEXT NOT NULL DEFAULT 'JOD',
    goods_to_jod_rate REAL NOT NULL DEFAULT 1.0,

    -- Computed totals (refreshed on save and on receipt)
    total_goods_ex_vat_jod REAL DEFAULT 0,
    total_vat_jod REAL DEFAULT 0,                     -- recoverable input VAT
    total_extra_costs_jod REAL DEFAULT 0,             -- shipping + customs + etc, ex-VAT
    total_landed_jod REAL DEFAULT 0,                  -- goods (ex-VAT) + extra costs (ex-VAT)

    notes TEXT DEFAULT '',
    created_by TEXT,
    created_at DATETIME DEFAULT (datetime('now')),
    received_by TEXT,
    received_at DATETIME
  )`).run();

  // 3. Purchase items — each line on a PO
  db.prepare(`CREATE TABLE IF NOT EXISTS purchase_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    po_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
    category_id INTEGER REFERENCES raw_material_categories(id),
    description TEXT NOT NULL,
    raw_sheet_id INTEGER REFERENCES raw_sheets(id),  -- nullable; links to existing catalog entry

    -- Sizing
    qty_ordered REAL NOT NULL,                       -- # of pieces ordered
    qty_received REAL,                                -- # actually received (set on receipt)
    dimensions_w_mm REAL,                             -- for sheet-type items
    dimensions_h_mm REAL,
    length_mm REAL,                                   -- for linear items (profiles)
    unit_size REAL NOT NULL DEFAULT 1,                -- size per piece in primary_unit (e.g. sqm/sheet)
    total_size REAL,                                  -- qty × unit_size (e.g. total sqm)

    -- Pricing (in PO's goods_currency)
    price_per_unit REAL NOT NULL,                    -- per primary_unit (e.g. EUR per sqm)
    line_subtotal_goods REAL,                         -- total_size × price_per_unit
    vat_rate REAL DEFAULT 0,                          -- e.g. 0.16 for 16%
    vat_amount_goods REAL DEFAULT 0,                  -- line_subtotal_goods × vat_rate
    line_total_goods REAL,                            -- subtotal + vat (what you pay supplier)

    -- Customs override: declared customs value if it differs from invoice value
    customs_value_override_goods REAL,                -- nullable; in goods_currency

    -- Final landed cost (computed at receipt time)
    landed_cost_per_unit_jod REAL,                    -- WAC ingredient: cost ÷ total_size, JOD/sqm
    total_landed_jod REAL,                            -- the line's full contribution to inventory value

    notes TEXT,
    sort_order INTEGER DEFAULT 0
  )`).run();

  // 4. Purchase costs — extras attached to a PO (shipping, clearance, customs, etc.)
  db.prepare(`CREATE TABLE IF NOT EXISTS purchase_costs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    po_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
    cost_type TEXT NOT NULL,                          -- shipping|clearance|transport|insurance|duty|customs_vat|handling|other
    description TEXT,
    paid_to TEXT,
    amount REAL NOT NULL,
    currency TEXT NOT NULL DEFAULT 'JOD',
    exchange_rate_to_jod REAL NOT NULL DEFAULT 1.0,
    amount_jod REAL,                                  -- amount × exchange_rate_to_jod
    vat_rate REAL DEFAULT 0,
    vat_amount_jod REAL DEFAULT 0,                    -- recoverable input VAT on the cost
    -- Note: amount_jod is EX-VAT (the cost itself); vat_amount_jod is added separately
    allocation_method TEXT NOT NULL DEFAULT 'by_value',
        -- by_value | by_customs_value | by_qty | by_size | manual
    allocation_overrides TEXT,                        -- JSON: {"item_id": percent, ...} when manual
    paid_date TEXT,
    invoice_ref TEXT,
    notes TEXT,
    sort_order INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT (datetime('now'))
  )`).run();

  // 5. Raw sheet batches — receipt records per SKU
  db.prepare(`CREATE TABLE IF NOT EXISTS raw_sheet_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_code TEXT NOT NULL UNIQUE,
    po_id INTEGER REFERENCES purchase_orders(id),
    po_item_id INTEGER REFERENCES purchase_items(id),
    raw_sheet_id INTEGER NOT NULL REFERENCES raw_sheets(id),
    qty_received REAL NOT NULL,                       -- # of physical sheets
    total_size_received REAL NOT NULL,                -- total sqm/m/kg in this batch
    landed_cost_per_unit_jod_at_receipt REAL,         -- snapshot of THIS batch's landed cost
    total_landed_cost_jod REAL,                       -- size × cost
    received_at DATETIME DEFAULT (datetime('now')),
    received_by TEXT,
    notes TEXT
  )`).run();

  // 6. Cost history — every WAC-changing event for audit + trend charts
  db.prepare(`CREATE TABLE IF NOT EXISTS raw_sheet_cost_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    raw_sheet_id INTEGER NOT NULL REFERENCES raw_sheets(id),
    ts DATETIME DEFAULT (datetime('now')),
    event TEXT NOT NULL,                              -- purchase | consumption | adjustment | opening
    ref_type TEXT,                                    -- batch | transaction | manual
    ref_id INTEGER,
    qty_before REAL,
    qty_after REAL,
    avg_cost_before REAL,
    avg_cost_after REAL,
    amount_jod REAL,                                  -- cost added (+) or removed (-)
    note TEXT,
    actor TEXT
  )`).run();

  // ── Migrations to existing tables ──────────────────────────────────────
  // raw_sheets: add running WAC + qty cache
  const trySql = sql => { try { db.prepare(sql).run(); } catch(_) {} };
  trySql("ALTER TABLE raw_sheets ADD COLUMN current_avg_cost_jod_per_unit REAL");
  trySql("ALTER TABLE raw_sheets ADD COLUMN current_qty_in_stock_units REAL");
  trySql("ALTER TABLE raw_sheets ADD COLUMN last_cost_update_at DATETIME");

  // raw_sheet_transactions: add batch link + cost snapshot
  trySql("ALTER TABLE raw_sheet_transactions ADD COLUMN batch_id INTEGER");
  trySql("ALTER TABLE raw_sheet_transactions ADD COLUMN cost_per_unit_at_time_jod REAL");
  trySql("ALTER TABLE raw_sheet_transactions ADD COLUMN total_cost_at_time_jod REAL");

  // purchase_orders: link to suppliers table (nullable; legacy POs use the text fields)
  trySql("ALTER TABLE purchase_orders ADD COLUMN supplier_id INTEGER REFERENCES suppliers(id)");

  // raw_sheets: link to manufacturers table. Existing brand/origin TEXT
  // columns are KEPT (don't drop) as a backup. UI prefers manufacturer_id;
  // raw text is the safety net if anything in the migration goes sideways.
  trySql("ALTER TABLE raw_sheets ADD COLUMN manufacturer_id INTEGER REFERENCES manufacturers(id)");

  // Helpful indexes
  trySql("CREATE INDEX IF NOT EXISTS idx_pi_po ON purchase_items(po_id)");
  trySql("CREATE INDEX IF NOT EXISTS idx_pc_po ON purchase_costs(po_id)");
  trySql("CREATE INDEX IF NOT EXISTS idx_batch_sheet ON raw_sheet_batches(raw_sheet_id)");
  trySql("CREATE INDEX IF NOT EXISTS idx_costhist_sheet ON raw_sheet_cost_history(raw_sheet_id, ts)");
  trySql("CREATE INDEX IF NOT EXISTS idx_rst_batch ON raw_sheet_transactions(batch_id)");
  trySql("CREATE INDEX IF NOT EXISTS idx_po_supplier ON purchase_orders(supplier_id)");
  trySql("CREATE INDEX IF NOT EXISTS idx_rs_manufacturer ON raw_sheets(manufacturer_id)");
} catch(e) { console.warn('[purchasing init]', e.message); }

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

// Generate next PO number — format PO-YYYY-NNNN, sequential within the year.
// We pull the highest existing for the current year and increment, so deletions
// don't reuse numbers.
function nextPoNumber() {
  const year = new Date().getFullYear();
  const prefix = `PO-${year}-`;
  const row = db.prepare(
    "SELECT po_number FROM purchase_orders WHERE po_number LIKE ? ORDER BY po_number DESC LIMIT 1"
  ).get(prefix + '%');
  let next = 1;
  if (row) {
    const m = row.po_number.match(/-(\d+)$/);
    if (m) next = parseInt(m[1], 10) + 1;
  }
  return prefix + String(next).padStart(4, '0');
}

// Compute a line item's derived fields (subtotal, VAT, total) from inputs.
// Mutates the item object in place. Used both on save and as input to receipt.
function recomputeItem(item) {
  const qty = +item.qty_ordered || 0;
  const unitSize = +item.unit_size || 1;
  const price = +item.price_per_unit || 0;
  const vatRate = +item.vat_rate || 0;

  item.total_size = round4(qty * unitSize);
  item.line_subtotal_goods = round4(item.total_size * price);
  item.vat_amount_goods = round4(item.line_subtotal_goods * vatRate);
  item.line_total_goods = round4(item.line_subtotal_goods + item.vat_amount_goods);
  return item;
}

function recomputeCost(cost) {
  const amt = +cost.amount || 0;
  const rate = +cost.exchange_rate_to_jod || 1;
  cost.amount_jod = round4(amt * rate);
  const vatRate = +cost.vat_rate || 0;
  cost.vat_amount_jod = round4(cost.amount_jod * vatRate);
  return cost;
}

// Refresh PO totals from its items + costs. Always called inside a transaction.
function refreshPoTotals(poId) {
  const items = db.prepare('SELECT * FROM purchase_items WHERE po_id=?').all(poId);
  const costs = db.prepare('SELECT * FROM purchase_costs WHERE po_id=?').all(poId);
  const po = db.prepare('SELECT goods_to_jod_rate FROM purchase_orders WHERE id=?').get(poId);
  const rate = po && po.goods_to_jod_rate ? +po.goods_to_jod_rate : 1;

  // Goods totals: sum of line subtotals (ex-VAT) + sum of VAT, all converted to JOD
  const totalGoodsExVatGoods = items.reduce((s, i) => s + (+i.line_subtotal_goods || 0), 0);
  const totalGoodsVatGoods   = items.reduce((s, i) => s + (+i.vat_amount_goods   || 0), 0);
  const totalGoodsExVatJod   = round4(totalGoodsExVatGoods * rate);
  const totalGoodsVatJod     = round4(totalGoodsVatGoods   * rate);

  // Extra cost totals: amount_jod is already ex-VAT and JOD-converted
  const totalExtraExVatJod = costs.reduce((s, c) => s + (+c.amount_jod     || 0), 0);
  const totalExtraVatJod   = costs.reduce((s, c) => s + (+c.vat_amount_jod || 0), 0);

  const totalLanded = round4(totalGoodsExVatJod + totalExtraExVatJod);
  const totalVat    = round4(totalGoodsVatJod   + totalExtraVatJod);

  db.prepare(`UPDATE purchase_orders SET
    total_goods_ex_vat_jod=?, total_vat_jod=?, total_extra_costs_jod=?, total_landed_jod=?
    WHERE id=?`).run(totalGoodsExVatGoods * rate, totalVat, totalExtraExVatJod, totalLanded, poId);
}

function round4(x) { return Math.round(x * 10000) / 10000; }

// Allocate one extra cost (amount_jod) across items per its allocation_method.
// Returns a Map of item_id -> allocated_amount_jod.
function allocateCost(cost, items) {
  const totalCostJod = +cost.amount_jod || 0;
  if (totalCostJod === 0 || items.length === 0) return new Map();

  let basis;
  switch (cost.allocation_method) {
    case 'by_qty':
      basis = items.map(i => +i.qty_received || +i.qty_ordered || 0);
      break;
    case 'by_size':
      basis = items.map(i => +i.total_size || 0);
      break;
    case 'by_customs_value':
      // Use customs override if set, otherwise fall back to subtotal
      basis = items.map(i => +i.customs_value_override_goods || +i.line_subtotal_goods || 0);
      break;
    case 'manual':
      // allocation_overrides is JSON like { "item_id": percent_0_to_100 }
      try {
        const overrides = JSON.parse(cost.allocation_overrides || '{}');
        const map = new Map();
        for (const item of items) {
          const pct = (+overrides[item.id] || 0) / 100;
          map.set(item.id, round4(totalCostJod * pct));
        }
        return map;
      } catch (_) {
        // Bad JSON — fall through to by_value
      }
      // intentional fallthrough
    case 'by_value':
    default:
      basis = items.map(i => +i.line_subtotal_goods || 0);
      break;
  }

  const totalBasis = basis.reduce((s, b) => s + b, 0);
  const map = new Map();
  if (totalBasis === 0) {
    // Nothing to allocate against — split equally as last resort
    const each = totalCostJod / items.length;
    items.forEach(i => map.set(i.id, round4(each)));
    return map;
  }
  items.forEach((item, idx) => {
    map.set(item.id, round4(totalCostJod * basis[idx] / totalBasis));
  });
  return map;
}

// ═══════════════════════════════════════════════════════════════════════════
// CATEGORIES
// ═══════════════════════════════════════════════════════════════════════════
router.get('/categories', (req, res) => {
  try {
    res.json(db.prepare('SELECT * FROM raw_material_categories ORDER BY sort_order, name').all());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/categories', requireAdmin, (req, res) => {
  try {
    const { code, name, primary_unit, sort_order } = req.body;
    if (!code || !name) return res.status(400).json({ error: 'code and name required' });
    const r = db.prepare(`INSERT INTO raw_material_categories (code, name, primary_unit, sort_order)
                          VALUES (?,?,?,?)`)
      .run(code.toUpperCase(), name, primary_unit || 'piece', +sort_order || 0);
    res.status(201).json(db.prepare('SELECT * FROM raw_material_categories WHERE id=?').get(r.lastInsertRowid));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/categories/:id', requireAdmin, (req, res) => {
  try {
    const { code, name, primary_unit, sort_order, active } = req.body;
    db.prepare(`UPDATE raw_material_categories SET code=?, name=?, primary_unit=?, sort_order=?, active=?
                WHERE id=?`)
      .run(code, name, primary_unit, +sort_order || 0, active === false ? 0 : 1, +req.params.id);
    res.json(db.prepare('SELECT * FROM raw_material_categories WHERE id=?').get(+req.params.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// SUPPLIERS — master table for PO references
// ═══════════════════════════════════════════════════════════════════════════
router.get('/suppliers', (req, res) => {
  try {
    const { active_only, q } = req.query;
    let sql = `SELECT s.*,
      (SELECT COUNT(*) FROM purchase_orders po WHERE po.supplier_id = s.id) AS po_count,
      (SELECT COALESCE(SUM(po.total_landed_jod), 0) FROM purchase_orders po
         WHERE po.supplier_id = s.id AND po.status='received') AS total_spend_jod
      FROM suppliers s WHERE 1=1`;
    const p = [];
    if (active_only === '1') { sql += ' AND s.active=1'; }
    if (q) { sql += ' AND (s.name LIKE ? OR s.country LIKE ?)'; p.push('%' + q + '%', '%' + q + '%'); }
    sql += ' ORDER BY s.sort_order, s.name';
    res.json(db.prepare(sql).all(...p));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/suppliers/:id', (req, res) => {
  try {
    const s = db.prepare('SELECT * FROM suppliers WHERE id=?').get(+req.params.id);
    if (!s) return res.status(404).json({ error: 'Not found' });
    res.json(s);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/suppliers', requireAdmin, (req, res) => {
  try {
    const d = req.body || {};
    if (!d.name || !d.name.trim()) return res.status(400).json({ error: 'name required' });
    const r = db.prepare(`INSERT INTO suppliers
      (name, country, default_currency, contact_email, contact_phone,
       payment_terms, default_lead_time_days, notes, sort_order, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      d.name.trim(),
      d.country || '',
      (d.default_currency || 'JOD').toUpperCase(),
      d.contact_email || '',
      d.contact_phone || '',
      d.payment_terms || '',
      d.default_lead_time_days || null,
      d.notes || '',
      +d.sort_order || 0,
      (req.user && req.user.name) || 'admin'
    );
    res.status(201).json(db.prepare('SELECT * FROM suppliers WHERE id=?').get(r.lastInsertRowid));
  } catch (e) {
    // UNIQUE constraint on name → friendly error
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Supplier with that name already exists' });
    res.status(500).json({ error: e.message });
  }
});

router.put('/suppliers/:id', requireAdmin, (req, res) => {
  try {
    const cur = db.prepare('SELECT * FROM suppliers WHERE id=?').get(+req.params.id);
    if (!cur) return res.status(404).json({ error: 'Not found' });
    const d = { ...cur, ...(req.body || {}) };
    db.prepare(`UPDATE suppliers SET
      name=?, country=?, default_currency=?, contact_email=?, contact_phone=?,
      payment_terms=?, default_lead_time_days=?, notes=?, active=?, sort_order=?
      WHERE id=?`).run(
      d.name, d.country || '', (d.default_currency || 'JOD').toUpperCase(),
      d.contact_email || '', d.contact_phone || '',
      d.payment_terms || '', d.default_lead_time_days || null,
      d.notes || '', d.active === false || d.active === 0 ? 0 : 1,
      +d.sort_order || 0, +req.params.id
    );
    res.json(db.prepare('SELECT * FROM suppliers WHERE id=?').get(+req.params.id));
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Supplier with that name already exists' });
    res.status(500).json({ error: e.message });
  }
});

router.delete('/suppliers/:id', requireAdmin, (req, res) => {
  try {
    // Don't actually DELETE — just deactivate. Preserves referential history.
    const used = db.prepare('SELECT COUNT(*) c FROM purchase_orders WHERE supplier_id=?').get(+req.params.id).c;
    if (used > 0) {
      db.prepare('UPDATE suppliers SET active=0 WHERE id=?').run(+req.params.id);
      return res.json({ ok: true, deactivated: true, message: `Deactivated (used in ${used} PO${used>1?'s':''})` });
    }
    db.prepare('DELETE FROM suppliers WHERE id=?').run(+req.params.id);
    res.json({ ok: true, deleted: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// MANUFACTURERS — master table for who actually makes the raw materials.
// Distinct from suppliers (vendors): manufacturer is on the raw_sheet,
// supplier/vendor is on the purchase_order. See schema comment above.
// ═══════════════════════════════════════════════════════════════════════════
router.get('/manufacturers', (req, res) => {
  try {
    const { active_only, q } = req.query;
    // Include raw_sheet_count for the listing — same pattern as suppliers'
    // po_count + total_spend, so the user sees usage at a glance.
    let sql = `SELECT m.*,
      (SELECT COUNT(*) FROM raw_sheets rs WHERE rs.manufacturer_id = m.id) AS raw_sheet_count
      FROM manufacturers m WHERE 1=1`;
    const p = [];
    if (active_only === '1') { sql += ' AND m.active=1'; }
    if (q) { sql += ' AND (m.name LIKE ? OR m.country LIKE ?)'; p.push('%' + q + '%', '%' + q + '%'); }
    sql += ' ORDER BY m.sort_order, m.name';
    res.json(db.prepare(sql).all(...p));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/manufacturers/:id', (req, res) => {
  try {
    const m = db.prepare('SELECT * FROM manufacturers WHERE id=?').get(+req.params.id);
    if (!m) return res.status(404).json({ error: 'Not found' });
    res.json(m);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/manufacturers', requireAdmin, (req, res) => {
  try {
    const d = req.body || {};
    if (!d.name || !d.name.trim()) return res.status(400).json({ error: 'name required' });
    const r = db.prepare(`INSERT INTO manufacturers
      (name, country, notes, sort_order, created_by)
      VALUES (?,?,?,?,?)`).run(
      d.name.trim(),
      d.country || '',
      d.notes || '',
      +d.sort_order || 0,
      (req.user && req.user.name) || 'admin'
    );
    res.status(201).json(db.prepare('SELECT * FROM manufacturers WHERE id=?').get(r.lastInsertRowid));
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Manufacturer with that name already exists' });
    res.status(500).json({ error: e.message });
  }
});

router.put('/manufacturers/:id', requireAdmin, (req, res) => {
  try {
    const cur = db.prepare('SELECT * FROM manufacturers WHERE id=?').get(+req.params.id);
    if (!cur) return res.status(404).json({ error: 'Not found' });
    const d = { ...cur, ...(req.body || {}) };
    db.prepare(`UPDATE manufacturers SET
      name=?, country=?, notes=?, active=?, sort_order=?
      WHERE id=?`).run(
      d.name, d.country || '', d.notes || '',
      (d.active === false || d.active === 0) ? 0 : 1,
      +d.sort_order || 0, +req.params.id
    );
    res.json(db.prepare('SELECT * FROM manufacturers WHERE id=?').get(+req.params.id));
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Manufacturer with that name already exists' });
    res.status(500).json({ error: e.message });
  }
});

router.delete('/manufacturers/:id', requireAdmin, (req, res) => {
  try {
    // Mirror the suppliers DELETE pattern: deactivate if used, hard-delete only orphans.
    const used = db.prepare('SELECT COUNT(*) c FROM raw_sheets WHERE manufacturer_id=?').get(+req.params.id).c;
    if (used > 0) {
      db.prepare('UPDATE manufacturers SET active=0 WHERE id=?').run(+req.params.id);
      return res.json({ ok: true, deactivated: true, message: `Deactivated (used by ${used} sheet${used>1?'s':''})` });
    }
    db.prepare('DELETE FROM manufacturers WHERE id=?').run(+req.params.id);
    res.json({ ok: true, deleted: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// PURCHASE ORDERS
// ═══════════════════════════════════════════════════════════════════════════

// GET / — list POs, with summary fields and optional filters
router.get('/', (req, res) => {
  try {
    const { status, supplier, from, to } = req.query;
    let sql = 'SELECT * FROM purchase_orders WHERE 1=1';
    const p = [];
    if (status)   { sql += ' AND status=?';        p.push(status); }
    if (supplier) { sql += ' AND supplier_name LIKE ?'; p.push('%' + supplier + '%'); }
    if (from)     { sql += ' AND order_date >= ?'; p.push(from); }
    if (to)       { sql += ' AND order_date <= ?'; p.push(to); }
    sql += ' ORDER BY order_date DESC, id DESC';
    res.json(db.prepare(sql).all(...p));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /:id — full PO with items + costs in one shot
router.get('/:id', (req, res) => {
  try {
    const po = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(+req.params.id);
    if (!po) return res.status(404).json({ error: 'Not found' });
    po.items = db.prepare('SELECT * FROM purchase_items WHERE po_id=? ORDER BY sort_order, id').all(+req.params.id);
    po.costs = db.prepare('SELECT * FROM purchase_costs WHERE po_id=? ORDER BY sort_order, id').all(+req.params.id);
    po.batches = db.prepare('SELECT * FROM raw_sheet_batches WHERE po_id=? ORDER BY id').all(+req.params.id);
    res.json(po);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST / — create a draft PO
router.post('/', requireAdmin, (req, res) => {
  try {
    const d = req.body || {};
    const poNum = d.po_number || nextPoNumber();

    // If supplier_id is provided, snapshot name/country/currency from the
    // supplier so the PO is self-contained even if the supplier is later
    // renamed or deactivated.
    let supplierName = d.supplier_name || 'Unknown';
    let supplierCountry = d.supplier_country || '';
    let currency = d.goods_currency || 'JOD';
    if (d.supplier_id) {
      const s = db.prepare('SELECT * FROM suppliers WHERE id=?').get(+d.supplier_id);
      if (s) {
        supplierName = s.name;
        supplierCountry = s.country;
        if (!d.goods_currency) currency = s.default_currency || 'JOD';
      }
    }

    const r = db.prepare(`INSERT INTO purchase_orders
      (po_number, purchase_type, supplier_id, supplier_name, supplier_country, order_date,
       expected_arrival, status, goods_currency, goods_to_jod_rate, notes, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      poNum,
      d.purchase_type || 'local',
      d.supplier_id ? +d.supplier_id : null,
      supplierName,
      supplierCountry,
      d.order_date || new Date().toISOString().slice(0, 10),
      d.expected_arrival || null,
      d.status || 'draft',
      currency,
      +d.goods_to_jod_rate || 1.0,
      d.notes || '',
      req.user && req.user.name || 'admin'
    );
    res.status(201).json(db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(r.lastInsertRowid));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /:id — update PO header (NOT items/costs, those have their own endpoints)
// PATCH /:id/arrived — update actual arrival date (works even on locked POs)
router.patch('/:id/arrived', requireAdmin, (req, res) => {
  try {
    const { actual_arrival } = req.body;
    const po = db.prepare('SELECT id FROM purchase_orders WHERE id=?').get(+req.params.id);
    if (!po) return res.status(404).json({ error: 'PO not found' });
    db.prepare('UPDATE purchase_orders SET actual_arrival=? WHERE id=?')
      .run(actual_arrival||null, +req.params.id);
    res.json({ ok: true, actual_arrival: actual_arrival||null });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id', requireAdmin, (req, res) => {
  try {
    const po = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(+req.params.id);
    if (!po) return res.status(404).json({ error: 'Not found' });
    if (po.locked) return res.status(403).json({ error: 'PO is locked. Use /adjust to make corrections.' });
    const d = req.body || {};

    // If supplier_id changed, refresh the snapshot fields. If only the text
    // fields are sent (legacy free-text mode), keep them as provided.
    let supplierId = d.supplier_id !== undefined ? (d.supplier_id ? +d.supplier_id : null) : po.supplier_id;
    let supplierName = d.supplier_name !== undefined ? d.supplier_name : po.supplier_name;
    let supplierCountry = d.supplier_country !== undefined ? d.supplier_country : po.supplier_country;
    if (d.supplier_id !== undefined && d.supplier_id) {
      const s = db.prepare('SELECT * FROM suppliers WHERE id=?').get(+d.supplier_id);
      if (s) { supplierName = s.name; supplierCountry = s.country; }
    }

    db.prepare(`UPDATE purchase_orders SET
      purchase_type=?, supplier_id=?, supplier_name=?, supplier_country=?, order_date=?,
      expected_arrival=?, status=?, goods_currency=?, goods_to_jod_rate=?, notes=?
      WHERE id=?`).run(
      d.purchase_type || po.purchase_type,
      supplierId,
      supplierName || 'Unknown',
      supplierCountry || '',
      d.order_date || po.order_date,
      d.expected_arrival ?? po.expected_arrival,
      d.status || po.status,
      d.goods_currency || po.goods_currency,
      +d.goods_to_jod_rate || po.goods_to_jod_rate,
      d.notes ?? po.notes,
      +req.params.id
    );
    refreshPoTotals(+req.params.id);
    res.json(db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(+req.params.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /:id
// Draft/cancelled POs → simple cascade delete.
// Received/locked POs → require ?force=1; fully reverses inventory effects:
//   1. Collects all raw_sheet_batches for this PO
//   2. Deletes raw_sheet_transactions tagged with those batch_ids
//   3. Deletes raw_sheet_cost_history rows for those batches
//   4. Deletes the batches themselves
//   5. Recomputes WAC + qty from scratch for each affected sheet
//      (replays all remaining purchase batches in chronological order)
//   6. Deletes the PO (cascades to items + costs)
router.delete('/:id', requireAdmin, (req, res) => {
  try {
    const po = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(+req.params.id);
    if (!po) return res.status(404).json({ error: 'Not found' });

    const isLocked = po.locked || po.status === 'received';

    if (isLocked && req.query.force !== '1') {
      return res.status(403).json({
        error: 'Cannot delete a received or locked PO',
        hint: 'Pass ?force=1 to reverse all inventory effects and delete.'
      });
    }

    if (isLocked) {
      // ── Force-delete: reverse all inventory effects in one transaction ──
      const batches = db.prepare('SELECT * FROM raw_sheet_batches WHERE po_id=?').all(po.id);
      const batchIds = batches.map(b => b.id);
      const affectedSheetIds = [...new Set(batches.map(b => b.raw_sheet_id))];

      const tx = db.transaction(() => {
        if (batchIds.length) {
          const ph = batchIds.map(() => '?').join(',');
          // Delete transactions linked to these batches
          db.prepare(`DELETE FROM raw_sheet_transactions WHERE batch_id IN (${ph})`).run(...batchIds);
          // Delete cost history linked to these batches
          db.prepare(`DELETE FROM raw_sheet_cost_history WHERE ref_type='batch' AND ref_id IN (${ph})`).run(...batchIds);
          // Delete the batches themselves
          db.prepare(`DELETE FROM raw_sheet_batches WHERE po_id=?`).run(po.id);
        }

        // Recompute WAC + qty for each affected sheet from remaining batches
        const getBatches = db.prepare(`
          SELECT b.raw_sheet_id, b.total_size_received, b.landed_cost_per_unit_jod_at_receipt,
                 b.total_landed_cost_jod, b.received_at
          FROM raw_sheet_batches b
          WHERE b.raw_sheet_id=?
          ORDER BY b.received_at ASC, b.id ASC
        `);
        const updSheet = db.prepare(`
          UPDATE raw_sheets SET current_avg_cost_jod_per_unit=?,
            current_qty_in_stock_units=?, last_cost_update_at=datetime('now') WHERE id=?
        `);
        // Also factor in non-purchase transactions (optimization_use, sale, adjustment)
        const getNonPurchaseTxns = db.prepare(`
          SELECT qty, type FROM raw_sheet_transactions
          WHERE sheet_id=? AND (batch_id IS NULL OR batch_id NOT IN (
            SELECT id FROM raw_sheet_batches WHERE raw_sheet_id=?
          ))
          ORDER BY created_at ASC
        `);

        for (const sheetId of affectedSheetIds) {
          const remainingBatches = getBatches.all(sheetId);
          // Replay WAC from scratch
          let qty = 0, totalValue = 0;
          for (const b of remainingBatches) {
            const size = +b.total_size_received || 0;
            const cost = +b.total_landed_cost_jod || 0;
            qty = round4(qty + size);
            totalValue += cost;
          }
          // Apply non-purchase deductions (cuts, sales, adjustments)
          const otherTxns = getNonPurchaseTxns.all(sheetId, sheetId);
          for (const t of otherTxns) {
            // These are in sheet units (not sqm) — just adjust qty
            qty = round4(qty + (+t.qty || 0)); // qty is signed (negative for deductions)
          }
          qty = Math.max(0, qty);
          const avgCost = qty > 0 ? round4(totalValue / qty) : 0;
          updSheet.run(avgCost, qty, sheetId);
        }

        // Delete PO (cascades to purchase_items + purchase_costs via FK)
        db.prepare('DELETE FROM purchase_orders WHERE id=?').run(po.id);
      });

      tx();
      return res.json({
        ok: true,
        reversed: { batches: batchIds.length, sheets: affectedSheetIds.length }
      });
    }

    // Simple delete for draft/cancelled POs
    db.prepare('DELETE FROM purchase_orders WHERE id=?').run(po.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// PURCHASE ITEMS
// ═══════════════════════════════════════════════════════════════════════════

router.post('/:id/items', requireAdmin, (req, res) => {
  try {
    const po = db.prepare('SELECT locked FROM purchase_orders WHERE id=?').get(+req.params.id);
    if (!po) return res.status(404).json({ error: 'PO not found' });
    if (po.locked) return res.status(403).json({ error: 'PO is locked' });

    const item = recomputeItem({ ...(req.body || {}) });
    const r = db.prepare(`INSERT INTO purchase_items
      (po_id, category_id, description, raw_sheet_id, qty_ordered, qty_received,
       dimensions_w_mm, dimensions_h_mm, length_mm, unit_size, total_size,
       price_per_unit, line_subtotal_goods, vat_rate, vat_amount_goods, line_total_goods,
       customs_value_override_goods, notes, sort_order)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      +req.params.id,
      item.category_id || null,
      item.description || '',
      item.raw_sheet_id || null,
      +item.qty_ordered || 0,
      item.qty_received != null ? +item.qty_received : null,
      item.dimensions_w_mm || null,
      item.dimensions_h_mm || null,
      item.length_mm || null,
      +item.unit_size || 1,
      item.total_size,
      +item.price_per_unit || 0,
      item.line_subtotal_goods,
      +item.vat_rate || 0,
      item.vat_amount_goods,
      item.line_total_goods,
      item.customs_value_override_goods || null,
      item.notes || '',
      +item.sort_order || 0
    );
    refreshPoTotals(+req.params.id);
    res.status(201).json(db.prepare('SELECT * FROM purchase_items WHERE id=?').get(r.lastInsertRowid));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/items/:itemId', requireAdmin, (req, res) => {
  try {
    const cur = db.prepare('SELECT * FROM purchase_items WHERE id=?').get(+req.params.itemId);
    if (!cur) return res.status(404).json({ error: 'Item not found' });
    const po = db.prepare('SELECT locked FROM purchase_orders WHERE id=?').get(cur.po_id);
    if (po.locked) return res.status(403).json({ error: 'PO is locked' });

    const merged = { ...cur, ...(req.body || {}) };
    recomputeItem(merged);
    db.prepare(`UPDATE purchase_items SET
      category_id=?, description=?, raw_sheet_id=?, qty_ordered=?, qty_received=?,
      dimensions_w_mm=?, dimensions_h_mm=?, length_mm=?, unit_size=?, total_size=?,
      price_per_unit=?, line_subtotal_goods=?, vat_rate=?, vat_amount_goods=?, line_total_goods=?,
      customs_value_override_goods=?, notes=?, sort_order=? WHERE id=?`).run(
      merged.category_id, merged.description, merged.raw_sheet_id || null,
      +merged.qty_ordered, merged.qty_received != null ? +merged.qty_received : null,
      merged.dimensions_w_mm, merged.dimensions_h_mm, merged.length_mm,
      +merged.unit_size, merged.total_size,
      +merged.price_per_unit, merged.line_subtotal_goods,
      +merged.vat_rate, merged.vat_amount_goods, merged.line_total_goods,
      merged.customs_value_override_goods, merged.notes, +merged.sort_order || 0,
      +req.params.itemId
    );
    refreshPoTotals(cur.po_id);
    res.json(db.prepare('SELECT * FROM purchase_items WHERE id=?').get(+req.params.itemId));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/items/:itemId', requireAdmin, (req, res) => {
  try {
    const cur = db.prepare('SELECT po_id FROM purchase_items WHERE id=?').get(+req.params.itemId);
    if (!cur) return res.status(404).json({ error: 'Item not found' });
    const po = db.prepare('SELECT locked FROM purchase_orders WHERE id=?').get(cur.po_id);
    if (po.locked) return res.status(403).json({ error: 'PO is locked' });
    db.prepare('DELETE FROM purchase_items WHERE id=?').run(+req.params.itemId);
    refreshPoTotals(cur.po_id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// PURCHASE COSTS
// ═══════════════════════════════════════════════════════════════════════════

router.post('/:id/costs', requireAdmin, (req, res) => {
  try {
    const po = db.prepare('SELECT locked FROM purchase_orders WHERE id=?').get(+req.params.id);
    if (!po) return res.status(404).json({ error: 'PO not found' });
    if (po.locked) return res.status(403).json({ error: 'PO is locked' });

    const cost = recomputeCost({ ...(req.body || {}) });
    const r = db.prepare(`INSERT INTO purchase_costs
      (po_id, cost_type, description, paid_to, amount, currency, exchange_rate_to_jod, amount_jod,
       vat_rate, vat_amount_jod, allocation_method, allocation_overrides,
       paid_date, invoice_ref, notes, sort_order)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      +req.params.id,
      cost.cost_type || 'other', cost.description || '', cost.paid_to || '',
      +cost.amount || 0, cost.currency || 'JOD',
      +cost.exchange_rate_to_jod || 1, cost.amount_jod,
      +cost.vat_rate || 0, cost.vat_amount_jod,
      cost.allocation_method || 'by_value',
      cost.allocation_overrides ? (typeof cost.allocation_overrides === 'string' ? cost.allocation_overrides : JSON.stringify(cost.allocation_overrides)) : null,
      cost.paid_date || null, cost.invoice_ref || '', cost.notes || '',
      +cost.sort_order || 0
    );
    refreshPoTotals(+req.params.id);
    res.status(201).json(db.prepare('SELECT * FROM purchase_costs WHERE id=?').get(r.lastInsertRowid));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/costs/:costId', requireAdmin, (req, res) => {
  try {
    const cur = db.prepare('SELECT * FROM purchase_costs WHERE id=?').get(+req.params.costId);
    if (!cur) return res.status(404).json({ error: 'Cost not found' });
    const po = db.prepare('SELECT locked FROM purchase_orders WHERE id=?').get(cur.po_id);
    if (po.locked) return res.status(403).json({ error: 'PO is locked' });

    const merged = recomputeCost({ ...cur, ...(req.body || {}) });
    db.prepare(`UPDATE purchase_costs SET
      cost_type=?, description=?, paid_to=?, amount=?, currency=?, exchange_rate_to_jod=?, amount_jod=?,
      vat_rate=?, vat_amount_jod=?, allocation_method=?, allocation_overrides=?,
      paid_date=?, invoice_ref=?, notes=?, sort_order=? WHERE id=?`).run(
      merged.cost_type, merged.description, merged.paid_to,
      +merged.amount, merged.currency, +merged.exchange_rate_to_jod, merged.amount_jod,
      +merged.vat_rate, merged.vat_amount_jod,
      merged.allocation_method,
      merged.allocation_overrides ? (typeof merged.allocation_overrides === 'string' ? merged.allocation_overrides : JSON.stringify(merged.allocation_overrides)) : null,
      merged.paid_date, merged.invoice_ref, merged.notes, +merged.sort_order || 0,
      +req.params.costId
    );
    refreshPoTotals(cur.po_id);
    res.json(db.prepare('SELECT * FROM purchase_costs WHERE id=?').get(+req.params.costId));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/costs/:costId', requireAdmin, (req, res) => {
  try {
    const cur = db.prepare('SELECT po_id FROM purchase_costs WHERE id=?').get(+req.params.costId);
    if (!cur) return res.status(404).json({ error: 'Cost not found' });
    const po = db.prepare('SELECT locked FROM purchase_orders WHERE id=?').get(cur.po_id);
    if (po.locked) return res.status(403).json({ error: 'PO is locked' });
    db.prepare('DELETE FROM purchase_costs WHERE id=?').run(+req.params.costId);
    refreshPoTotals(cur.po_id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// PREVIEW LANDED COST — dry-run computation, no DB writes
// Useful for showing the user what receipt will produce before they commit.
// ═══════════════════════════════════════════════════════════════════════════
router.get('/:id/preview', (req, res) => {
  try {
    const po = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(+req.params.id);
    if (!po) return res.status(404).json({ error: 'Not found' });
    const items = db.prepare('SELECT * FROM purchase_items WHERE po_id=?').all(+req.params.id);
    const costs = db.prepare('SELECT * FROM purchase_costs WHERE po_id=?').all(+req.params.id);
    const result = computeLandedCosts(po, items, costs);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Pure compute function — used by both preview and receipt.
// Returns: { items: [{...item, allocated_extras_jod, landed_cost_per_unit_jod, total_landed_jod}],
//            totals: {goods_ex_vat_jod, vat_jod, extra_costs_jod, landed_jod} }
function computeLandedCosts(po, items, costs) {
  const rate = +po.goods_to_jod_rate || 1;
  // Convert each item's subtotal/vat to JOD up front
  const enriched = items.map(item => {
    const subJod = (+item.line_subtotal_goods || 0) * rate;
    const vatJod = (+item.vat_amount_goods || 0) * rate;
    const customsValueJod = (+item.customs_value_override_goods != null && +item.customs_value_override_goods > 0)
      ? (+item.customs_value_override_goods) * rate
      : subJod;
    return {
      ...item,
      _subtotal_jod: subJod,
      _vat_jod: vatJod,
      _customs_value_jod: customsValueJod,
      _allocated_extras_jod: 0,  // accumulator
    };
  });

  // Allocate each cost across items
  for (const cost of costs) {
    const map = allocateCost(cost, enriched);
    enriched.forEach(item => {
      const share = map.get(item.id) || 0;
      item._allocated_extras_jod = round4(item._allocated_extras_jod + share);
    });
  }

  // Compute landed cost per item
  enriched.forEach(item => {
    const totalSize = +item.total_size || 0;
    item.landed_cost_per_unit_jod = totalSize > 0
      ? round4((item._subtotal_jod + item._allocated_extras_jod) / totalSize)
      : 0;
    item.total_landed_jod = round4(item._subtotal_jod + item._allocated_extras_jod);
    item.allocated_extras_jod = item._allocated_extras_jod;  // expose without underscore
  });

  // Totals
  const totals = {
    goods_ex_vat_jod: round4(enriched.reduce((s, i) => s + i._subtotal_jod, 0)),
    vat_goods_jod:    round4(enriched.reduce((s, i) => s + i._vat_jod, 0)),
    extra_costs_jod:  round4(costs.reduce((s, c) => s + (+c.amount_jod || 0), 0)),
    extra_vat_jod:    round4(costs.reduce((s, c) => s + (+c.vat_amount_jod || 0), 0)),
    landed_jod:       round4(enriched.reduce((s, i) => s + i.total_landed_jod, 0)),
  };
  totals.total_recoverable_vat_jod = round4(totals.vat_goods_jod + totals.extra_vat_jod);

  // Strip internal fields before returning
  const cleanItems = enriched.map(({ _subtotal_jod, _vat_jod, _customs_value_jod, _allocated_extras_jod, ...rest }) => rest);
  return { items: cleanItems, totals };
}

// ═══════════════════════════════════════════════════════════════════════════
// RECEIVE — the moment of truth. Atomic transaction that:
//   1. Creates raw_sheet_batches
//   2. Updates raw_sheets WAC + qty
//   3. Writes raw_sheet_transactions with cost snapshots
//   4. Writes raw_sheet_cost_history rows
//   5. Locks the PO
// ═══════════════════════════════════════════════════════════════════════════
router.post('/:id/receive', requireAdmin, (req, res) => {
  try {
    const po = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(+req.params.id);
    if (!po) return res.status(404).json({ error: 'Not found' });
    if (po.locked) return res.status(403).json({ error: 'PO already received' });

    const items = db.prepare('SELECT * FROM purchase_items WHERE po_id=?').all(+req.params.id);
    if (!items.length) return res.status(400).json({ error: 'PO has no items' });

    // Validate: every item with a raw_sheet_id needs unit_size > 0
    for (const item of items) {
      if (!item.raw_sheet_id) {
        return res.status(400).json({
          error: `Item "${item.description}" needs to be linked to a raw sheet before receipt.`
        });
      }
      if (!item.qty_ordered || +item.qty_ordered <= 0) {
        return res.status(400).json({ error: `Item "${item.description}" has zero quantity` });
      }
      if (!item.total_size || +item.total_size <= 0) {
        return res.status(400).json({ error: `Item "${item.description}" has zero total_size — set dimensions and unit_size` });
      }
    }

    const costs = db.prepare('SELECT * FROM purchase_costs WHERE po_id=?').all(+req.params.id);
    const computed = computeLandedCosts(po, items, costs);
    const actor = (req.user && req.user.name) || 'admin';
    const overrides = req.body && req.body.qty_received_overrides || {}; // { item_id: qty_actually_received }

    const tx = db.transaction(() => {
      const insBatch = db.prepare(`INSERT INTO raw_sheet_batches
        (batch_code, po_id, po_item_id, raw_sheet_id, qty_received, total_size_received,
         landed_cost_per_unit_jod_at_receipt, total_landed_cost_jod, received_by)
        VALUES (?,?,?,?,?,?,?,?,?)`);
      const insTxn = db.prepare(`INSERT INTO raw_sheet_transactions
        (sheet_id, type, qty, ref_id, ref_label, date, notes, created_by, created_at,
         batch_id, cost_per_unit_at_time_jod, total_cost_at_time_jod)
        VALUES (?, 'purchase', ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?)`);
      const insHist = db.prepare(`INSERT INTO raw_sheet_cost_history
        (raw_sheet_id, event, ref_type, ref_id, qty_before, qty_after,
         avg_cost_before, avg_cost_after, amount_jod, note, actor)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
      const updItem = db.prepare(`UPDATE purchase_items SET qty_received=?,
        landed_cost_per_unit_jod=?, total_landed_jod=? WHERE id=?`);
      const updSheet = db.prepare(`UPDATE raw_sheets SET
        current_avg_cost_jod_per_unit=?, current_qty_in_stock_units=?, last_cost_update_at=datetime('now')
        WHERE id=?`);
      const getSheet = db.prepare('SELECT current_avg_cost_jod_per_unit, current_qty_in_stock_units FROM raw_sheets WHERE id=?');

      const batches = [];

      for (const item of computed.items) {
        const qtyReceived = overrides[item.id] != null ? +overrides[item.id] : (+item.qty_ordered);
        if (qtyReceived <= 0) continue;
        const totalSizeReceived = round4(qtyReceived * (+item.unit_size || 1));
        const landedPerUnit     = +item.landed_cost_per_unit_jod || 0;
        const totalLandedJod    = round4(totalSizeReceived * landedPerUnit);

        // 1. Batch row
        const batchCode = `B-${po.po_number}-${item.id}`;
        const batchRes = insBatch.run(
          batchCode, po.id, item.id, item.raw_sheet_id,
          qtyReceived, totalSizeReceived, landedPerUnit, totalLandedJod, actor
        );
        const batchId = batchRes.lastInsertRowid;

        // 2. Update raw_sheets WAC: avg_after = (oldQty*oldAvg + addedSize*landed) / newQty
        const sheet = getSheet.get(item.raw_sheet_id) || {};
        const qtyBefore = +sheet.current_qty_in_stock_units || 0;
        const avgBefore = +sheet.current_avg_cost_jod_per_unit || 0;
        const valueBefore = qtyBefore * avgBefore;
        const qtyAfter = round4(qtyBefore + totalSizeReceived);
        const valueAfter = valueBefore + totalLandedJod;
        const avgAfter = qtyAfter > 0 ? round4(valueAfter / qtyAfter) : 0;
        updSheet.run(avgAfter, qtyAfter, item.raw_sheet_id);

        // 3. Transaction row (with cost snapshot)
        insTxn.run(
          item.raw_sheet_id, qtyReceived, po.id, po.po_number,
          new Date().toISOString().slice(0, 10),
          `Received via ${po.po_number}`, actor,
          batchId, landedPerUnit, totalLandedJod
        );

        // 4. Cost history
        insHist.run(
          item.raw_sheet_id, 'purchase', 'batch', batchId,
          qtyBefore, qtyAfter, avgBefore, avgAfter, totalLandedJod,
          `Receipt from ${po.po_number}`, actor
        );

        // 5. Update purchase_items with final landed values
        updItem.run(qtyReceived, landedPerUnit, totalLandedJod, item.id);

        batches.push({ id: batchId, batch_code: batchCode, item_id: item.id });
      }

      // 6. Lock the PO
      db.prepare(`UPDATE purchase_orders SET
        status='received', locked=1, actual_arrival=date('now'),
        received_by=?, received_at=datetime('now')
        WHERE id=?`).run(actor, po.id);

      refreshPoTotals(po.id);
      return batches;
    });

    const batches = tx();
    res.json({
      ok: true,
      message: `Received ${batches.length} batch(es) into inventory`,
      batches,
      totals: computed.totals
    });
  } catch (e) {
    console.error('[receive PO]', e);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ADJUST — post-receipt corrections (manual qty/cost change against a batch)
// Creates a raw_sheet_cost_history entry; doesn't unlock the PO.
// ═══════════════════════════════════════════════════════════════════════════
router.post('/batches/:batchId/adjust', requireAdmin, (req, res) => {
  try {
    const { qty_delta, cost_delta_jod, note } = req.body || {};
    const batch = db.prepare('SELECT * FROM raw_sheet_batches WHERE id=?').get(+req.params.batchId);
    if (!batch) return res.status(404).json({ error: 'Batch not found' });
    const sheet = db.prepare('SELECT * FROM raw_sheets WHERE id=?').get(batch.raw_sheet_id);
    if (!sheet) return res.status(404).json({ error: 'Raw sheet not found' });

    const qtyDelta = +qty_delta || 0;        // in units of primary unit (sqm), can be negative
    const costDelta = +cost_delta_jod || 0;  // total cost adjustment in JOD, can be negative
    if (qtyDelta === 0 && costDelta === 0) return res.status(400).json({ error: 'Nothing to adjust' });

    const actor = (req.user && req.user.name) || 'admin';
    const tx = db.transaction(() => {
      const qtyBefore = +sheet.current_qty_in_stock_units || 0;
      const avgBefore = +sheet.current_avg_cost_jod_per_unit || 0;
      const valueBefore = qtyBefore * avgBefore;

      const qtyAfter = round4(qtyBefore + qtyDelta);
      const valueAfter = valueBefore + costDelta;
      const avgAfter = qtyAfter > 0 ? round4(valueAfter / qtyAfter) : 0;

      db.prepare(`UPDATE raw_sheets SET
        current_avg_cost_jod_per_unit=?, current_qty_in_stock_units=?, last_cost_update_at=datetime('now')
        WHERE id=?`).run(avgAfter, qtyAfter, sheet.id);

      db.prepare(`INSERT INTO raw_sheet_cost_history
        (raw_sheet_id, event, ref_type, ref_id, qty_before, qty_after,
         avg_cost_before, avg_cost_after, amount_jod, note, actor)
        VALUES (?,'adjustment','batch',?,?,?,?,?,?,?,?)`).run(
        sheet.id, batch.id, qtyBefore, qtyAfter, avgBefore, avgAfter, costDelta,
        note || 'Manual adjustment', actor
      );
    });
    tx();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// OPENING WAC — set initial cost for a SKU that has stock but no cost basis.
// Used at first cutover to seed weighted average for legacy stock.
// ═══════════════════════════════════════════════════════════════════════════
router.post('/opening-wac', requireAdmin, (req, res) => {
  try {
    const { raw_sheet_id, qty_in_stock_units, avg_cost_jod_per_unit, note } = req.body || {};
    const id = +raw_sheet_id;
    if (!id) return res.status(400).json({ error: 'raw_sheet_id required' });
    const qty = +qty_in_stock_units;
    const cost = +avg_cost_jod_per_unit;
    if (!(qty > 0)) return res.status(400).json({ error: 'qty_in_stock_units must be > 0' });
    if (!(cost > 0)) return res.status(400).json({ error: 'avg_cost_jod_per_unit must be > 0' });

    const sheet = db.prepare('SELECT * FROM raw_sheets WHERE id=?').get(id);
    if (!sheet) return res.status(404).json({ error: 'Raw sheet not found' });

    const actor = (req.user && req.user.name) || 'admin';
    const tx = db.transaction(() => {
      db.prepare(`UPDATE raw_sheets SET
        current_avg_cost_jod_per_unit=?, current_qty_in_stock_units=?, last_cost_update_at=datetime('now')
        WHERE id=?`).run(cost, qty, id);
      db.prepare(`INSERT INTO raw_sheet_cost_history
        (raw_sheet_id, event, ref_type, qty_before, qty_after,
         avg_cost_before, avg_cost_after, amount_jod, note, actor)
        VALUES (?, 'opening', 'manual', ?, ?, ?, ?, ?, ?, ?)`).run(
        id, sheet.current_qty_in_stock_units || 0, qty,
        sheet.current_avg_cost_jod_per_unit || 0, cost,
        round4(qty * cost),
        note || 'Opening WAC seed', actor
      );
    });
    tx();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// REPORTS — quick rollups
// ═══════════════════════════════════════════════════════════════════════════

// Cost history for a single SKU (for a trend chart)
router.get('/cost-history/:sheetId', (req, res) => {
  try {
    const limit = Math.min(+req.query.limit || 200, 1000);
    res.json(db.prepare(
      'SELECT * FROM raw_sheet_cost_history WHERE raw_sheet_id=? ORDER BY ts DESC LIMIT ?'
    ).all(+req.params.sheetId, limit));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Spend by supplier in a date range
router.get('/reports/supplier-spend', (req, res) => {
  try {
    const { from, to } = req.query;
    let sql = `SELECT supplier_name, supplier_country,
                      COUNT(*) AS po_count,
                      SUM(total_landed_jod) AS spend_jod,
                      SUM(total_vat_jod) AS recoverable_vat_jod
               FROM purchase_orders
               WHERE status='received'`;
    const p = [];
    if (from) { sql += ' AND order_date >= ?'; p.push(from); }
    if (to)   { sql += ' AND order_date <= ?'; p.push(to); }
    sql += ' GROUP BY supplier_name, supplier_country ORDER BY spend_jod DESC';
    res.json(db.prepare(sql).all(...p));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Inventory valuation: current stock × current WAC per SKU
router.get('/reports/inventory-value', (req, res) => {
  try {
    const rows = db.prepare(`SELECT
        rs.id, rs.code, rs.thickness, rs.glass_type, rs.color,
        rs.current_qty_in_stock_units AS qty_units,
        rs.current_avg_cost_jod_per_unit AS avg_cost_jod,
        ROUND(COALESCE(rs.current_qty_in_stock_units,0) * COALESCE(rs.current_avg_cost_jod_per_unit,0), 4) AS stock_value_jod
      FROM raw_sheets rs
      ORDER BY stock_value_jod DESC`).all();
    const totalValue = rows.reduce((s, r) => s + (+r.stock_value_jod || 0), 0);
    res.json({ rows, total_value_jod: round4(totalValue) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
