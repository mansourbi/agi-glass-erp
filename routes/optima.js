// routes/optima.js — Optima Export (cutting batches). Phase 2: foundations.
//
// Spec:   C:\AGI\docs\optima-export-spec.md
// Report: C:\AGI\docs\optima-phase0-report.md  (§6 carries the approved DDL)
//
// Phase 2 scope: idempotent migrations + the material map. Batch creation, the file
// writer and delivery are Phase 3; mark-as-cut and stock deduction are Phase 4.
//
// Decision 11: the edge allowance belongs to Optima, not the ERP. There are no
// comp_w/comp_h columns and no cut_w/cut_h columns anywhere below, deliberately.
// Cols 1-2 of the export carry order_items.w/h — the FINISHED size.

const router = require('express').Router();
const db     = require('../db');
const { requireAuth } = require('../middleware/auth');
const fs = require('fs');
const { validateOptimaName, assertIdentity, sanitise } = require('../optima-text');
const { writeArchive } = require('../optima-xls');
const { deliver } = require('../optima-deliver');

// ── Migrations (idempotent, run at module load like the rest of the codebase) ──
// Order matters: cutting_batches must exist before the label_items ALTER.

// 1. customers.optima_name — NOT seeded (decision 4). The UI suggests customers.code.
try { db.prepare('ALTER TABLE customers ADD COLUMN optima_name TEXT').run(); } catch (e) {}
try {
  db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_cust_optima_name
              ON customers(optima_name) WHERE optima_name IS NOT NULL`).run();
} catch (e) { console.warn('[optima migrate] idx_cust_optima_name:', e.message); }

// 2. Material map — ERP thickness -> Edit-Way code.
try {
  db.prepare(`CREATE TABLE IF NOT EXISTS optima_material_map (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    thickness     REAL NOT NULL UNIQUE,
    editway_code  TEXT NOT NULL,
    active        INTEGER NOT NULL DEFAULT 1,
    notes         TEXT DEFAULT '',
    updated_by    TEXT DEFAULT '',
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
} catch (e) { console.warn('[optima migrate] optima_material_map:', e.message); }

// 3. Cutting batches.
try {
  db.prepare(`CREATE TABLE IF NOT EXISTS cutting_batches (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_no        TEXT NOT NULL UNIQUE,
    thickness       REAL NOT NULL,
    glass_type      TEXT NOT NULL DEFAULT 'glass',
    color           TEXT NOT NULL DEFAULT '',
    family          TEXT,
    pattern         TEXT,
    company         TEXT,
    material_code   TEXT NOT NULL,
    manufacturer_id   INTEGER REFERENCES manufacturers(id),
    manufacturer_code TEXT,
    status          TEXT NOT NULL DEFAULT 'created',
    file_name       TEXT,
    archive_path    TEXT,
    delivery_status TEXT NOT NULL DEFAULT 'pending',
    delivered_at    TEXT,
    delivery_error  TEXT,
    delivery_tries  INTEGER NOT NULL DEFAULT 0,
    order_nums      TEXT NOT NULL DEFAULT '[]',
    piece_count     INTEGER NOT NULL DEFAULT 0,
    sheets_used     REAL,
    cut_at          TEXT,
    cut_by          TEXT,
    cancelled_at    TEXT,
    cancelled_by    TEXT,
    notes           TEXT DEFAULT '',
    created_by      TEXT DEFAULT '',
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_cb_status ON cutting_batches(status)').run();
} catch (e) { console.warn('[optima migrate] cutting_batches:', e.message); }
// The manufacturer snapshot was agreed after the table shipped in Phase 2, so
// CREATE TABLE IF NOT EXISTS cannot add it to an existing database. NOTE1 needs
// it (spec §5) and it is snapshotted so a rename cannot rewrite history.
try { db.prepare('ALTER TABLE cutting_batches ADD COLUMN manufacturer_id INTEGER REFERENCES manufacturers(id)').run(); } catch (e) {}
try { db.prepare('ALTER TABLE cutting_batches ADD COLUMN manufacturer_code TEXT').run(); } catch (e) {}

// Decision 13 (Ala, 2026-10-04) REVERSES decision 11: the cut-size allowance comes
// back into the ERP. Columns 1-2 of the export now carry w+comp_w and h+comp_h, and
// each piece can override its own cut size.
//
// THE RISK THIS CREATES: Edit-Way has its own per-side allowance, which the operator
// has been entering by hand. If both are applied the glass is cut twice oversize.
// Columns 8-12 stay empty so the FILE never adds it a second time, but the machine's
// own setting is outside this file's control and must be zeroed on that side.
try { db.prepare('ALTER TABLE cutting_batches ADD COLUMN comp_w REAL NOT NULL DEFAULT 4').run(); } catch (e) {}
try { db.prepare('ALTER TABLE cutting_batches ADD COLUMN comp_h REAL NOT NULL DEFAULT 4').run(); } catch (e) {}
// The per-piece cut_w/cut_h ALTERs live AFTER the cutting_batch_pieces CREATE
// below — running them here would silently no-op on a fresh database, where the
// table does not exist yet, and the columns would never appear.
try {
  db.prepare("INSERT OR IGNORE INTO config (key,value) VALUES ('optima_default_comp_w','4')").run();
  db.prepare("INSERT OR IGNORE INTO config (key,value) VALUES ('optima_default_comp_h','4')").run();
} catch (e) { console.warn('[optima seed] default allowance:', e.message); }

// 4. Batch membership. Authoritative, independent of labels. Holds the finished
// size (w/h) and, since decision 13, the cut size actually exported (cut_w/cut_h).
try {
  db.prepare(`CREATE TABLE IF NOT EXISTS cutting_batch_pieces (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id     INTEGER NOT NULL REFERENCES cutting_batches(id),
    piece_uid    TEXT NOT NULL,
    active       INTEGER NOT NULL DEFAULT 1,
    order_id     INTEGER REFERENCES orders(id),
    order_num    TEXT NOT NULL,
    customer_id  INTEGER REFERENCES customers(id),
    optima_name  TEXT NOT NULL,
    w            REAL NOT NULL,
    h            REAL NOT NULL,
    thickness    REAL NOT NULL,
    glass_type   TEXT,
    color        TEXT,
    family       TEXT,
    pattern      TEXT,
    processes    TEXT NOT NULL DEFAULT '[]',
    note1        TEXT DEFAULT '',
    note2        TEXT DEFAULT '',
    cut_w        REAL,
    cut_h        REAL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_cbp_batch ON cutting_batch_pieces(batch_id)').run();
  // Exclusivity at the DATABASE, not the UI: 55 piece UIDs already sit in two opt
  // files each because the optimizer's equivalent check is dead code (landmines §9).
  db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_cbp_active_uid
              ON cutting_batch_pieces(piece_uid) WHERE active = 1`).run();
} catch (e) { console.warn('[optima migrate] cutting_batch_pieces:', e.message); }
// Decision 13, for databases where the table already existed. NULL on an old row
// means "no allowance recorded"; the writer falls back to the finished size.
try { db.prepare('ALTER TABLE cutting_batch_pieces ADD COLUMN cut_w REAL').run(); } catch (e) {}
try { db.prepare('ALTER TABLE cutting_batch_pieces ADD COLUMN cut_h REAL').run(); } catch (e) {}

// 5. Label linkage. Nullable and additive: every existing label row keeps NULL, so
// label and scan history for existing optimizations is untouched. opt_file_id must
// stay NULL for batch pieces — it is FK'd to opt_files and the opt DELETE cascade
// removes label_items by it.
try { db.prepare('ALTER TABLE label_items ADD COLUMN batch_id INTEGER REFERENCES cutting_batches(id)').run(); } catch (e) {}
try { db.prepare('CREATE INDEX IF NOT EXISTS idx_label_batch ON label_items(batch_id)').run(); }
catch (e) { console.warn('[optima migrate] idx_label_batch:', e.message); }

// ── Material map seed ────────────────────────────────────────────────────────
// Per-row INSERT OR IGNORE, never a one-shot "already seeded" guard (landmines §6:
// a backfill gated on a global flag ran once against empty data and was permanently
// "done"). This never clobbers a code a human has edited.
//
// 5.5 -> '6' is deliberate (decision 3): 5.5 cannot be added to Edit-Way, so 5.5mm
// glass is cut on the 6mm material setting. The ERP keeps the true 5.5 everywhere
// else — batch glass key, filename and NOTE1 — so the operator loads the right sheets.
const SEED = [[3,'3'],[4,'4'],[5,'5'],[5.5,'6'],[6,'6'],[8,'8'],[10,'10'],[12,'12'],[15,'15'],[19,'19']];
try {
  const ins = db.prepare(`INSERT OR IGNORE INTO optima_material_map
    (thickness, editway_code, notes, updated_by) VALUES (?,?,?,'seed')`);
  const seedTx = db.transaction(() => {
    for (const [t, c] of SEED) {
      ins.run(t, c, String(t) === c ? '' : `${t}mm cut on the ${c}mm Edit-Way setting`);
    }
  });
  seedTx();
} catch (e) { console.warn('[optima seed] material map:', e.message); }

// ── Cutting batches apply to NEW work only (decision 12, Ala 2026-10-01) ─────
// "Do not touch the past. I want it to work for new orders only."
//
// Every order that existed when Optima went live already carries an ERP
// optimization — a new one is created within hours of each order arriving — and
// decision 2 blocks any piece held by a pending optimization. Without a cutoff
// that is a permanent stalemate, not a backlog: measured 1 Oct 2026, 0 of 60
// pool pieces were batchable and all 60 were blocked by a pending optimization.
//
// So the past is excluded STRUCTURALLY: only orders with id > the cutoff are ever
// considered. Existing orders, optimizations, labels and scans are never read as
// candidates and never modified. The 60 claimed pieces stay with the ERP
// optimizer, which is where their layouts already are.
//
// Why orders.id and not a date: the database mixes UTC and local timestamps and
// string comparison on them has silently dropped whole days at ten query sites
// (landmines.md §5). `id` is monotonic, timezone-proof and auditable — verified
// 0 pairs where a later id carries an earlier date. The UI shows the human
// boundary ("orders after REF-616, 30 Sep 2026") alongside the number.
//
// Seeded once to MAX(orders.id) at first boot after install. On a fresh database
// with no history that is 0, which correctly makes everything eligible.
try {
  const existing = db.prepare("SELECT value FROM config WHERE key='optima_min_order_id'").get();
  if (!existing) {
    const mx = db.prepare('SELECT COALESCE(MAX(id),0) m FROM orders').get().m;
    db.prepare("INSERT INTO config (key,value) VALUES ('optima_min_order_id',?)").run(String(mx));
    console.log('[optima] batch cutoff seeded at orders.id > ' + mx);
  }
} catch (e) { console.warn('[optima seed] cutoff:', e.message); }

function minOrderId() {
  try {
    const r = db.prepare("SELECT value FROM config WHERE key='optima_min_order_id'").get();
    const n = r ? parseInt(r.value, 10) : 0;
    return Number.isFinite(n) ? n : 0;
  } catch (e) { return 0; }
}

router.use(requireAuth);

// Codes verified to exist in this Edit-Way installation (spec §2). An unknown code
// leaves Edit-Way's material prompt BLANK and any manual choice is accepted
// silently, putting pieces on the wrong thickness — so a typo here is expensive.
const EDITWAY_CODES = ['3','4','5','6','8','10','12','15','19'];

// GET /api/optima/material-map
router.get('/material-map', (req, res) => {
  try {
    res.json(db.prepare('SELECT * FROM optima_material_map ORDER BY thickness').all());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/optima/material-map — upsert one row
router.post('/material-map', (req, res) => {
  try {
    const thickness = Number(req.body.thickness);
    const code      = String(req.body.editway_code == null ? '' : req.body.editway_code).trim();
    const active    = req.body.active == null ? 1 : (+req.body.active ? 1 : 0);
    const notes     = String(req.body.notes || '');

    if (!isFinite(thickness) || thickness <= 0)
      return res.status(400).json({ error: 'thickness must be a positive number' });
    if (!EDITWAY_CODES.includes(code))
      return res.status(400).json({
        error: `"${code}" is not a material code in this Edit-Way installation. ` +
               `Known codes: ${EDITWAY_CODES.join(' ')}.`
      });

    db.prepare(`INSERT INTO optima_material_map (thickness, editway_code, active, notes, updated_by, updated_at)
      VALUES (?,?,?,?,?,datetime('now'))
      ON CONFLICT(thickness) DO UPDATE SET
        editway_code=excluded.editway_code, active=excluded.active,
        notes=excluded.notes, updated_by=excluded.updated_by, updated_at=datetime('now')`)
      .run(thickness, code, active, notes, req.user?.name || '');

    res.json(db.prepare('SELECT * FROM optima_material_map WHERE thickness=?').get(thickness));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/optima/material-map/:thickness — removing a row BLOCKS that thickness
router.delete('/material-map/:thickness', (req, res) => {
  try {
    const t = Number(req.params.thickness);
    if (!isFinite(t)) return res.status(400).json({ error: 'bad thickness' });
    const r = db.prepare('DELETE FROM optima_material_map WHERE thickness=?').run(t);
    res.json({ ok: true, removed: r.changes });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/optima/settings — the batch cutoff, with the human boundary resolved
router.get('/settings', (req, res) => {
  try {
    const min = minOrderId();
    const boundary = db.prepare('SELECT num, date FROM orders WHERE id=?').get(min) || null;
    const next = db.prepare('SELECT num, date FROM orders WHERE id>? ORDER BY id LIMIT 1').get(min) || null;
    res.json({
      min_order_id: min,
      // Destination only. The account and password stay in .env and are never
      // returned, logged, or put anywhere a browser can see them.
      share_path: process.env.OPTIMA_SHARE_PATH || null,
      share_configured: !!(process.env.OPTIMA_SHARE_PATH && process.env.OPTIMA_SHARE_USER && process.env.OPTIMA_SHARE_PASS),
      boundary_order: boundary,          // the last order NOT eligible
      first_eligible_order: next,        // null until a new order arrives
      note: 'Batches consider orders with id greater than min_order_id. Lowering this exposes historical orders, which already carry their own optimizations.'
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/optima/settings — move the cutoff. Deliberately blunt: there is no
// reason to lower it in normal use, so the response says what it would expose.
router.post('/settings', (req, res) => {
  try {
    const n = parseInt(req.body.min_order_id, 10);
    if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: 'min_order_id must be a non-negative integer' });
    const prev = minOrderId();
    const exposed = n < prev
      ? db.prepare('SELECT COUNT(*) c FROM orders WHERE id>? AND id<=?').get(n, prev).c
      : 0;
    db.prepare("INSERT INTO config (key,value,updated_at) VALUES ('optima_min_order_id',?,datetime('now')) " +
               "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')").run(String(n));
    res.json({ ok: true, min_order_id: n, previous: prev, historical_orders_exposed: exposed });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/optima/customers — who has an Optima name, and the suggested default.
// The suggestion is customers.code; Ala confirms or edits it (decision 4).
router.get('/customers', (req, res) => {
  try {
    const rows = db.prepare('SELECT id, code, name, company, optima_name FROM customers ORDER BY code').all();
    res.json(rows.map(r => ({ ...r, suggested_optima_name: r.optima_name || r.code })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/optima/customers/:id/optima-name — the inline fix used by batch creation.
// The customer profile form saves through PUT /api/customers/:id, which accepts the
// same field via the same validator.
router.put('/customers/:id/optima-name', (req, res) => {
  try {
    const id = +req.params.id;
    const cust = db.prepare('SELECT id FROM customers WHERE id=?').get(id);
    if (!cust) return res.status(404).json({ error: 'Customer not found' });

    let name;
    try { name = validateOptimaName(req.body.optima_name); }
    catch (ve) { return res.status(400).json({ error: ve.message }); }

    if (name) {
      const clash = db.prepare('SELECT id, code FROM customers WHERE optima_name=? AND id<>?').get(name, id);
      if (clash) return res.status(409).json({ error: `"${name}" is already used by customer ${clash.code}` });
    }
    db.prepare("UPDATE customers SET optima_name=?, updated_at=datetime('now') WHERE id=?").run(name, id);
    res.json(db.prepare('SELECT id, code, name, optima_name FROM customers WHERE id=?').get(id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// CUTTING BATCHES
// The ERP optimizer and an Optima batch are ALTERNATIVES for the same work: a
// piece goes down one path or the other, never both. The optimizer claims a piece
// through label_items.opt_file_id; a batch claims it through
// cutting_batch_pieces(piece_uid) WHERE active=1, which is a unique index, so the
// database refuses a double claim rather than trusting a UI check.
// ═══════════════════════════════════════════════════════════════════════════

const EDGE_ABBR = { flat:'FP', arrising:'ARR', drilling:'DRL', cutouts:'CO', bevel:'BEV', round:'RND' };
const glassKeyOf = r => [r.thickness, r.glass_type || 'glass', (r.color || '').trim(),
                         r.family || '', (r.pattern || '').trim()].join('|');

// NOTE1 carries the manufacturer so the operator knows which stack to load.
// Resolution order is the documented material-code one (modules.md §6):
//   explicit manufacturers.code > the MFGCODE segment of raw_sheets.code > company
// Measured 3 Oct 2026: only 29 of 47 non-virtual sheets carry a manufacturer_id and
// NONE of the glass currently in play does, so the join alone would silently yield
// no manufacturer at all. The code segment is where it actually lives:
//   55FLO-OBKKSA-CLR-01 -> OBK      06FLO-SGGEGY-BRZ-01 -> SGG
function resolveManufacturer(thickness, color, family) {
  let rs = null;
  try {
    rs = db.prepare(`SELECT id, code, company, manufacturer_id FROM raw_sheets
                     WHERE thickness=? AND COALESCE(color,'')=COALESCE(?,'')
                       AND COALESCE(family,'')=COALESCE(?,'') AND is_virtual=0
                     ORDER BY manufacturer_id IS NULL, id LIMIT 1`).get(thickness, color, family);
  } catch (e) { return null; }
  if (!rs) return null;
  if (rs.manufacturer_id) {
    const m = db.prepare('SELECT id, code FROM manufacturers WHERE id=?').get(rs.manufacturer_id);
    if (m && m.code) return { id: m.id, code: sanitise(String(m.code).toUpperCase(), 8) || null };
  }
  // MFGCODE segment: second dash-separated part, first three characters.
  const seg = String(rs.code || '').split('-')[1] || '';
  const fromCode = (seg.match(/^[A-Za-z0-9]{3}/) || [''])[0].toUpperCase();
  if (fromCode) return { id: null, code: fromCode };
  const fromCompany = sanitise(String(rs.company || '').toUpperCase(), 8).replace(/[^A-Z0-9]/g, '').slice(0, 3);
  return fromCompany ? { id: null, code: fromCompany } : null;
}

// Everything the eligibility rule needs, in one pass. Spec §8, conditions 1-6.
function poolRows(where, params) {
  const cutScanned = new Set(db.prepare(
    "SELECT DISTINCT piece_uid FROM scan_log WHERE action='done' AND process='cutting'").all().map(r => r.piece_uid));
  const labels = new Map(db.prepare(
    `SELECT l.uid, l.opt_file_id, f.status opt_status, f.name opt_name
     FROM label_items l LEFT JOIN opt_files f ON f.id = l.opt_file_id`).all().map(r => [r.uid, r]));
  const claimed = new Map(db.prepare(
    `SELECT p.piece_uid, b.batch_no FROM cutting_batch_pieces p
     JOIN cutting_batches b ON b.id = p.batch_id WHERE p.active = 1`).all().map(r => [r.piece_uid, r.batch_no]));
  const matMap = new Map(db.prepare('SELECT thickness, editway_code, active FROM optima_material_map').all()
    .map(r => [r.thickness, r]));

  const rows = db.prepare(`
    SELECT o.id order_id, o.num order_num, o.date order_date, o.extref, o.notes order_notes,
           c.id customer_id, c.code cust_code, c.name cust_name, c.optima_name,
           oi.code piece_code, oi.w, oi.h, oi.thickness, oi.glass_type, oi.color, oi.family,
           oi.pattern, oi.processes, oi.piece_uids, oi.bevel_mm, oi.drill_count, oi.cutout_count
    FROM orders o
    JOIN customers c ON c.id = o.customer_id
    JOIN order_items oi ON oi.order_id = o.id
    WHERE o.status NOT IN ('done','cancelled')
      AND o.id > ?
      ${where || ''}
    ORDER BY o.num, oi.sort_order, oi.id`).all(minOrderId(), ...(params || []));

  const out = [];
  for (const r of rows) {
    let procs = [], uids = [];
    try { procs = JSON.parse(r.processes || '[]'); } catch (e) {}
    try { uids = JSON.parse(r.piece_uids || '[]'); } catch (e) {}
    if (!procs.includes('cutting')) continue;                 // condition 6
    for (const uid of uids) {
      const lab = labels.get(uid) || {};
      if (lab.opt_file_id != null && lab.opt_status === 'done') continue;   // condition 3
      if (cutScanned.has(uid)) continue;                                   // condition 4
      if (claimed.has(uid)) continue;                                      // condition 5
      const mm = matMap.get(r.thickness);
      const blockers = [];
      if (lab.opt_file_id != null) blockers.push(
        'in ' + (lab.opt_status || 'open') + ' ERP optimization #' + lab.opt_file_id +
        (lab.opt_name ? ' — "' + lab.opt_name + '"' : '') +
        '. Delete that optimization or remove the order from it, or cut it on the ERP optimizer instead.');
      if (!mm) blockers.push(r.thickness + 'mm is not set up in Optima');
      else if (!mm.active) blockers.push(r.thickness + 'mm is mapped but inactive in the material map');
      if (!r.optima_name) blockers.push('Customer ' + r.cust_code + ' has no Optima name');
      try { assertIdentity('ORDER', r.order_num, 12); } catch (e) { blockers.push(e.message); }
      try { assertIdentity('NOTE (piece UID)', uid, 32); } catch (e) { blockers.push(e.message); }
      out.push({
        piece_uid: uid, order_id: r.order_id, order_num: r.order_num, order_date: r.order_date,
        customer_id: r.customer_id, cust_code: r.cust_code, cust_name: r.cust_name,
        optima_name: r.optima_name, suggested_optima_name: r.optima_name || r.cust_code,
        w: r.w, h: r.h, thickness: r.thickness, glass_type: r.glass_type, color: r.color,
        family: r.family, pattern: r.pattern, processes: procs, piece_code: r.piece_code,
        bevel_mm: r.bevel_mm, drill_count: r.drill_count, cutout_count: r.cutout_count,
        material_code: mm ? mm.editway_code : null,
        glass_key: glassKeyOf(r), blockers
      });
    }
  }
  return out;
}

// GET /api/optima/eligible — the pool, grouped by glass, for the New Batch screen
router.get('/eligible', (req, res) => {
  try {
    const all = poolRows();
    const groups = {};
    for (const p of all) {
      const g = groups[p.glass_key] || (groups[p.glass_key] = {
        glass_key: p.glass_key, thickness: p.thickness, glass_type: p.glass_type,
        color: p.color, family: p.family, pattern: p.pattern,
        material_code: p.material_code, pieces: 0, ready: 0, orders: {}
      });
      g.pieces++;
      if (!p.blockers.length) g.ready++;
      const o = g.orders[p.order_num] || (g.orders[p.order_num] = {
        order_id: p.order_id, order_num: p.order_num, order_date: p.order_date,
        cust_code: p.cust_code, optima_name: p.optima_name,
        suggested_optima_name: p.suggested_optima_name, pieces: [], blockers: []
      });
      o.pieces.push({ piece_uid: p.piece_uid, w: p.w, h: p.h, piece_code: p.piece_code, processes: p.processes });
      p.blockers.forEach(b => { if (!o.blockers.includes(b)) o.blockers.push(b); });
    }
    res.json({
      min_order_id: minOrderId(),
      total_pieces: all.length,
      ready_pieces: all.filter(p => !p.blockers.length).length,
      groups: Object.values(groups).map(g => ({ ...g, orders: Object.values(g.orders) }))
        .sort((a, b) => b.pieces - a.pieces)
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Batch numbers are MAX(suffix)+1, never COUNT+1 — one deletion must not re-issue
// a live number (landmines.md §6, which cost a delivery serial collision). The
// test imports on the cutting PC used OX0000-OX0006, so production starts at 7.
function nextBatchNo() {
  const rows = db.prepare("SELECT batch_no FROM cutting_batches WHERE batch_no GLOB 'OX[0-9][0-9][0-9][0-9]'").all();
  let max = 6;
  for (const r of rows) { const n = parseInt(String(r.batch_no).slice(2), 10); if (Number.isFinite(n) && n > max) max = n; }
  return 'OX' + String(max + 1).padStart(4, '0');
}

// POST /api/optima/batches — create a batch from whole orders of one glass type
router.post('/batches', (req, res) => {
  try {
    const glassKey = String(req.body.glass_key || '');
    const orderIds = Array.isArray(req.body.order_ids) ? req.body.order_ids.map(Number).filter(Boolean) : [];
    if (!glassKey) return res.status(400).json({ error: 'glass_key required' });
    if (!orderIds.length) return res.status(400).json({ error: 'select at least one order' });

    const pool = poolRows().filter(p => p.glass_key === glassKey && orderIds.includes(p.order_id));
    if (!pool.length) return res.status(409).json({ error: 'No eligible pieces for that glass and those orders. The screen may be stale — reload.' });

    const blocked = pool.filter(p => p.blockers.length);
    if (blocked.length) {
      return res.status(409).json({
        error: 'Cannot create the batch: ' + blocked.length + ' piece(s) are blocked.',
        blocked: blocked.map(p => ({ piece_uid: p.piece_uid, order_num: p.order_num, blockers: p.blockers }))
      });
    }
    const first = pool[0];
    const mfg = resolveManufacturer(first.thickness, first.color, first.family);

    const note1 = sanitise([first.thickness, (first.color || '').toUpperCase(),
      ((first.pattern || '').trim() || first.family || '').toUpperCase(),
      mfg ? mfg.code : ''].filter(Boolean).join(' '), 32);

    const comp = defaultComp();                  // decision 13, default 4mm per axis
    const batchNo = nextBatchNo();
    const orderNums = [...new Set(pool.map(p => p.order_num))];
    const created = (req.user && (req.user.name || req.user.email)) || '';

    const txn = db.transaction(() => {
      const bid = db.prepare(`INSERT INTO cutting_batches
        (batch_no, thickness, glass_type, color, family, pattern, company, material_code,
         manufacturer_id, manufacturer_code, order_nums, piece_count, created_by, comp_w, comp_h)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        batchNo, first.thickness, first.glass_type || 'glass', (first.color || '').trim(),
        first.family || null, (first.pattern || '').trim() || null, null, first.material_code,
        mfg ? mfg.id : null, mfg ? mfg.code : null,
        JSON.stringify(orderNums), pool.length, created, comp.w, comp.h).lastInsertRowid;

      const insPiece = db.prepare(`INSERT INTO cutting_batch_pieces
        (batch_id, piece_uid, order_id, order_num, customer_id, optima_name, w, h, thickness,
         glass_type, color, family, pattern, processes, note1, note2, cut_w, cut_h)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      // Labels: batch_id set, opt_file_id deliberately left alone. Worker scanning
      // resolves a piece by uid, so it works unchanged once these rows exist.
      const upLabel = db.prepare(`INSERT INTO label_items
        (uid, code, w, h, thickness, glass_type, color, family, pattern, processes, bevel_mm,
         drill_count, cutout_count, order_id, order_num, cut_type, date, batch_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'machine',?,?)
        ON CONFLICT(uid) DO UPDATE SET
          code=excluded.code, w=excluded.w, h=excluded.h, thickness=excluded.thickness,
          glass_type=excluded.glass_type, color=excluded.color, family=excluded.family,
          pattern=excluded.pattern, processes=excluded.processes, bevel_mm=excluded.bevel_mm,
          drill_count=excluded.drill_count, cutout_count=excluded.cutout_count,
          order_id=excluded.order_id, order_num=excluded.order_num, batch_id=excluded.batch_id`);

      const d = new Date(), p2 = n => String(n).padStart(2, '0');
      const today = d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());  // local parts

      for (const p of pool) {
        const note2 = sanitise(p.processes.filter(x => x !== 'cutting')
          .map(x => EDGE_ABBR[x] || x.toUpperCase()).join(' '), 32);
        insPiece.run(bid, p.piece_uid, p.order_id, p.order_num, p.customer_id, p.optima_name,
          p.w, p.h, p.thickness, p.glass_type, p.color, p.family, p.pattern,
          JSON.stringify(p.processes), note1, note2, p.w + comp.w, p.h + comp.h);
        upLabel.run(p.piece_uid, p.piece_code || '', p.w, p.h, p.thickness, p.glass_type || 'glass',
          p.color || 'clear', p.family || null, p.pattern || null, JSON.stringify(p.processes),
          p.bevel_mm || 0, p.drill_count || 0, p.cutout_count || 0,
          p.order_id, p.order_num, today, bid);
      }
      return bid;
    });
    const id = txn();
    res.status(201).json(batchDetail(id));
  } catch (e) {
    // The partial unique index is the real guard against a double claim.
    if (/UNIQUE/i.test(e.message)) {
      return res.status(409).json({ error: 'One or more pieces were claimed by another batch while you were working. Reload and try again.' });
    }
    console.error('[optima batch create]', e);
    res.status(500).json({ error: e.message });
  }
});

function batchDetail(id) {
  const b = db.prepare('SELECT * FROM cutting_batches WHERE id=?').get(+id);
  if (!b) return null;
  const pieces = db.prepare('SELECT * FROM cutting_batch_pieces WHERE batch_id=? ORDER BY order_num, piece_uid').all(+id);
  const byOrder = {};
  for (const p of pieces) {
    (byOrder[p.order_num] = byOrder[p.order_num] || { order_num: p.order_num, order_id: p.order_id, pieces: [] })
      .pieces.push({ ...p, processes: JSON.parse(p.processes || '[]') });
  }
  return { ...b, order_nums: JSON.parse(b.order_nums || '[]'), orders: Object.values(byOrder), pieces_total: pieces.length };
}

// GET /api/optima/batches — list
router.get('/batches', (req, res) => {
  try {
    const status = req.query.status;
    const rows = status
      ? db.prepare('SELECT * FROM cutting_batches WHERE status=? ORDER BY id DESC').all(status)
      : db.prepare('SELECT * FROM cutting_batches ORDER BY id DESC').all();
    // covered_order_ids mirrors what optfiles exposes: the portal's tracking matrix
    // and the orders list both decide "has this order reached the saw?" from a
    // coverage set, and a batch is the other way it gets there.
    const covered = db.prepare(`SELECT DISTINCT order_id FROM cutting_batch_pieces
                                WHERE active=1 AND order_id IS NOT NULL`).all().map(r => r.order_id);
    res.json(rows.map(b => ({
      ...b,
      order_nums: JSON.parse(b.order_nums || '[]'),
      covered_order_ids: covered
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/optima/batches/:id — detail, pieces grouped by order
router.get('/batches/:id', (req, res) => {
  try {
    const d = batchDetail(req.params.id);
    if (!d) return res.status(404).json({ error: 'Batch not found' });
    res.json(d);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/optima/batches/:id/cancel — before cut only. Frees the pieces by
// clearing `active`, which is what the partial unique index keys on.
router.post('/batches/:id/cancel', (req, res) => {
  try {
    const b = db.prepare('SELECT * FROM cutting_batches WHERE id=?').get(+req.params.id);
    if (!b) return res.status(404).json({ error: 'Batch not found' });
    if (b.status === 'cut') return res.status(409).json({ error: 'This batch is already marked cut and cannot be cancelled.' });
    if (b.status === 'cancelled') return res.json({ ok: true, already: true, ...batchDetail(b.id) });
    const who = (req.user && (req.user.name || req.user.email)) || '';
    db.transaction(() => {
      db.prepare("UPDATE cutting_batches SET status='cancelled', cancelled_at=datetime('now'), cancelled_by=? WHERE id=?").run(who, b.id);
      db.prepare('UPDATE cutting_batch_pieces SET active=0 WHERE batch_id=?').run(b.id);
      // The labels stay: they may already be printed and stuck to glass. Only the
      // claim is released, so the pieces can go down either path again.
      db.prepare('UPDATE label_items SET batch_id=NULL WHERE batch_id=?').run(b.id);
    })();
    res.json({
      ok: true,
      warn_delivered: b.delivery_status === 'delivered'
        ? 'This batch was already delivered. Remove ' + (b.file_name || 'the file') +
          ' from the To-Import folder on the cutting PC and delete the work order in Edit-Way.'
        : null,
      ...batchDetail(b.id)
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Cut-size allowance (decision 13) ─────────────────────────────────────────
function defaultComp() {
  const g = k => {
    const r = db.prepare('SELECT value FROM config WHERE key=?').get(k);
    const n = r ? Number(r.value) : NaN;
    return Number.isFinite(n) && n >= 0 ? n : 4;
  };
  return { w: g('optima_default_comp_w'), h: g('optima_default_comp_h') };
}
// Rounded to 0.5mm and clamped, mirroring the optimizer's own Edge Compensation
// input (min 0, max 50, step 0.5) so the two paths cannot disagree on what is sane.
function cleanComp(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(50, Math.max(0, Math.round(n * 2) / 2));
}
// Recompute every piece's cut size from the batch allowance. "Apply to all" is
// deliberate: it overwrites per-piece overrides, which is what the operator means
// when they set a batch-wide figure.
function applyAllowance(batchId, compW, compH) {
  db.prepare(`UPDATE cutting_batch_pieces SET cut_w = w + ?, cut_h = h + ?
              WHERE batch_id=? AND active=1`).run(compW, compH, batchId);
}

// PATCH /api/optima/batches/:id/allowance  { comp_w, comp_h }
router.patch('/batches/:id/allowance', (req, res) => {
  try {
    const b = db.prepare('SELECT * FROM cutting_batches WHERE id=?').get(+req.params.id);
    assertEditable(b);
    const cw = cleanComp(req.body.comp_w, b.comp_w);
    const ch = cleanComp(req.body.comp_h, b.comp_h);
    db.transaction(() => {
      db.prepare('UPDATE cutting_batches SET comp_w=?, comp_h=? WHERE id=?').run(cw, ch, b.id);
      applyAllowance(b.id, cw, ch);
    })();
    const after = afterContentChange(db.prepare('SELECT * FROM cutting_batches WHERE id=?').get(b.id));
    res.json({ ok: true, comp_w: cw, comp_h: ch, ...after, ...batchDetail(b.id) });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// PATCH /api/optima/batches/:id/pieces/:uid  { cut_w, cut_h } — one piece only
router.patch('/batches/:id/pieces/:uid', (req, res) => {
  try {
    const b = db.prepare('SELECT * FROM cutting_batches WHERE id=?').get(+req.params.id);
    assertEditable(b);
    const uid = String(req.params.uid);
    const p = db.prepare('SELECT * FROM cutting_batch_pieces WHERE batch_id=? AND piece_uid=? AND active=1').get(b.id, uid);
    if (!p) return res.status(404).json({ error: 'That piece is not in this batch' });
    const cw = Number(req.body.cut_w), ch = Number(req.body.cut_h);
    if (!Number.isFinite(cw) || !Number.isFinite(ch) || cw <= 0 || ch <= 0) {
      return res.status(400).json({ error: 'Cut width and height must both be positive numbers' });
    }
    // A cut size below the finished size would cut the piece too small, which is
    // scrap. Refuse rather than warn.
    if (cw < p.w || ch < p.h) {
      return res.status(400).json({ error: 'Cut size cannot be smaller than the finished size (' + p.w + ' × ' + p.h + ' mm)' });
    }
    db.prepare('UPDATE cutting_batch_pieces SET cut_w=?, cut_h=? WHERE batch_id=? AND piece_uid=?')
      .run(cw, ch, b.id, uid);
    const after = afterContentChange(b);
    res.json({ ok: true, piece_uid: uid, cut_w: cw, cut_h: ch, ...after, ...batchDetail(b.id) });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ── Editing a batch before it is cut ─────────────────────────────────────────
// Allowed only while status='created'. Once marked cut the stock has moved and the
// glass is on the floor, so the contents are history.
//
// Any change invalidates the file that was already generated and possibly already
// delivered, so both are reset: the file is regenerated and delivery_status drops
// back to 'pending'. The response says whether a stale copy is sitting on the
// cutting PC, because Edit-Way will happily keep the old work order.
function assertEditable(b) {
  if (!b) throw Object.assign(new Error('Batch not found'), { status: 404 });
  if (b.status === 'cut') throw Object.assign(new Error('This batch is marked cut — its contents cannot change.'), { status: 409 });
  if (b.status === 'cancelled') throw Object.assign(new Error('This batch is cancelled.'), { status: 409 });
}
function afterContentChange(b) {
  const wasDelivered = b.delivery_status === 'delivered';
  let file = null;
  try { file = generateFile(b.id); } catch (e) { /* reported below */ }
  db.prepare(`UPDATE cutting_batches SET delivery_status='pending', delivery_error=NULL,
              piece_count=(SELECT COUNT(*) FROM cutting_batch_pieces WHERE batch_id=? AND active=1),
              order_nums=? WHERE id=?`)
    .run(b.id, JSON.stringify([...new Set(db.prepare(
      'SELECT order_num FROM cutting_batch_pieces WHERE batch_id=? AND active=1 ORDER BY order_num').all(b.id)
      .map(r => r.order_num))]), b.id);
  return {
    regenerated: !!file,
    file_name: file ? file.fileName : null,
    warn_stale_delivery: wasDelivered
      ? 'This batch had already been delivered. The old file is still in To-Import on the cutting PC — remove it and its work order in Edit-Way, then deliver again.'
      : null
  };
}

// POST /api/optima/batches/:id/pieces — add whole orders of the batch's glass
router.post('/batches/:id/pieces', (req, res) => {
  try {
    const b = db.prepare('SELECT * FROM cutting_batches WHERE id=?').get(+req.params.id);
    assertEditable(b);
    const orderIds = (Array.isArray(req.body.order_ids) ? req.body.order_ids : []).map(Number).filter(Boolean);
    if (!orderIds.length) return res.status(400).json({ error: 'Select at least one order to add' });

    const key = [b.thickness, b.glass_type || 'glass', (b.color || '').trim(), b.family || '', (b.pattern || '').trim()].join('|');
    const pool = poolRows().filter(p => p.glass_key === key && orderIds.includes(p.order_id));
    if (!pool.length) return res.status(409).json({ error: 'No eligible pieces of this glass in those orders. They may already be claimed — reload.' });
    const blocked = pool.filter(p => p.blockers.length);
    if (blocked.length) return res.status(409).json({
      error: blocked.length + ' piece(s) are blocked and cannot be added.',
      blocked: blocked.map(p => ({ piece_uid: p.piece_uid, order_num: p.order_num, blockers: p.blockers }))
    });

    const note1 = db.prepare('SELECT note1 FROM cutting_batch_pieces WHERE batch_id=? LIMIT 1').get(b.id);
    const d = new Date(), p2 = n => String(n).padStart(2, '0');
    const today = d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());

    db.transaction(() => {
      const insPiece = db.prepare(`INSERT INTO cutting_batch_pieces
        (batch_id, piece_uid, order_id, order_num, customer_id, optima_name, w, h, thickness,
         glass_type, color, family, pattern, processes, note1, note2, cut_w, cut_h)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      const upLabel = db.prepare(`INSERT INTO label_items
        (uid, code, w, h, thickness, glass_type, color, family, pattern, processes, bevel_mm,
         drill_count, cutout_count, order_id, order_num, cut_type, date, batch_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'machine',?,?)
        ON CONFLICT(uid) DO UPDATE SET batch_id=excluded.batch_id, order_id=excluded.order_id,
          order_num=excluded.order_num, processes=excluded.processes`);
      for (const p of pool) {
        const note2 = sanitise(p.processes.filter(x => x !== 'cutting')
          .map(x => EDGE_ABBR[x] || x.toUpperCase()).join(' '), 32);
        insPiece.run(b.id, p.piece_uid, p.order_id, p.order_num, p.customer_id, p.optima_name,
          p.w, p.h, p.thickness, p.glass_type, p.color, p.family, p.pattern,
          JSON.stringify(p.processes), (note1 && note1.note1) || '', note2,
          p.w + b.comp_w, p.h + b.comp_h);
        upLabel.run(p.piece_uid, p.piece_code || '', p.w, p.h, p.thickness, p.glass_type || 'glass',
          p.color || 'clear', p.family || null, p.pattern || null, JSON.stringify(p.processes),
          p.bevel_mm || 0, p.drill_count || 0, p.cutout_count || 0,
          p.order_id, p.order_num, today, b.id);
      }
    })();
    const after = afterContentChange(b);
    res.json({ ok: true, added: pool.length, ...after, ...batchDetail(b.id) });
  } catch (e) {
    if (/UNIQUE/i.test(e.message)) return res.status(409).json({ error: 'One or more pieces were claimed by another batch. Reload and try again.' });
    res.status(e.status || 500).json({ error: e.message });
  }
});

// DELETE /api/optima/batches/:id/pieces/:uid — drop one piece back to the pool
router.delete('/batches/:id/pieces/:uid', (req, res) => {
  try {
    const b = db.prepare('SELECT * FROM cutting_batches WHERE id=?').get(+req.params.id);
    assertEditable(b);
    const uid = String(req.params.uid);
    const row = db.prepare('SELECT * FROM cutting_batch_pieces WHERE batch_id=? AND piece_uid=? AND active=1').get(b.id, uid);
    if (!row) return res.status(404).json({ error: 'That piece is not in this batch' });
    const left = db.prepare('SELECT COUNT(*) c FROM cutting_batch_pieces WHERE batch_id=? AND active=1').get(b.id).c;
    if (left <= 1) return res.status(409).json({ error: 'A batch cannot be emptied. Cancel it instead, which frees every piece.' });

    db.transaction(() => {
      // active=0 rather than DELETE: the partial unique index keys on active, so
      // this frees the piece while leaving the record of what was in the batch.
      db.prepare('UPDATE cutting_batch_pieces SET active=0 WHERE batch_id=? AND piece_uid=?').run(b.id, uid);
      db.prepare('UPDATE label_items SET batch_id=NULL WHERE uid=? AND batch_id=?').run(uid, b.id);
    })();
    const after = afterContentChange(b);
    res.json({ ok: true, removed: uid, ...after, ...batchDetail(b.id) });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// GET /api/optima/batches/:id/addable — orders that could join this batch
router.get('/batches/:id/addable', (req, res) => {
  try {
    const b = db.prepare('SELECT * FROM cutting_batches WHERE id=?').get(+req.params.id);
    if (!b) return res.status(404).json({ error: 'Batch not found' });
    const key = [b.thickness, b.glass_type || 'glass', (b.color || '').trim(), b.family || '', (b.pattern || '').trim()].join('|');
    const pool = poolRows().filter(p => p.glass_key === key);
    const byOrder = {};
    pool.forEach(p => {
      const o = byOrder[p.order_num] || (byOrder[p.order_num] = {
        order_id: p.order_id, order_num: p.order_num, cust_code: p.cust_code, pieces: [], blockers: []
      });
      o.pieces.push({ piece_uid: p.piece_uid, w: p.w, h: p.h });
      p.blockers.forEach(x => { if (!o.blockers.includes(x)) o.blockers.push(x); });
    });
    res.json({ glass_key: key, editable: b.status === 'created', orders: Object.values(byOrder) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── File generation and archive ───────────────────────────────────────────────
// Generation is a separate, idempotent step rather than something buried in create,
// so Download and Retry can both work and a failed write never loses the batch.
function generateFile(id) {
  const b = db.prepare('SELECT * FROM cutting_batches WHERE id=?').get(+id);
  if (!b) throw Object.assign(new Error('Batch not found'), { status: 404 });
  if (b.status === 'cancelled') throw Object.assign(new Error('This batch is cancelled'), { status: 409 });
  const pieces = db.prepare('SELECT * FROM cutting_batch_pieces WHERE batch_id=? AND active=1 ORDER BY order_num, piece_uid').all(+id);
  if (!pieces.length) throw Object.assign(new Error('Batch has no active pieces'), { status: 409 });
  const out = writeArchive(b, pieces);
  db.prepare('UPDATE cutting_batches SET file_name=?, archive_path=? WHERE id=?').run(out.fileName, out.archivePath, b.id);
  return out;
}

// POST /api/optima/batches/:id/file — (re)generate and archive
router.post('/batches/:id/file', (req, res) => {
  try { res.json({ ok: true, ...generateFile(req.params.id) }); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// GET /api/optima/batches/:id/download — always available as the fallback when
// network delivery is not working. Regenerates if the archive copy is missing.
router.get('/batches/:id/download', (req, res) => {
  try {
    const b = db.prepare('SELECT * FROM cutting_batches WHERE id=?').get(+req.params.id);
    if (!b) return res.status(404).json({ error: 'Batch not found' });
    let p = b.archive_path, name = b.file_name;
    if (!p || !fs.existsSync(p)) { const g = generateFile(b.id); p = g.archivePath; name = g.fileName; }
    res.setHeader('Content-Type', 'application/vnd.ms-excel');
    res.setHeader('Content-Disposition', 'attachment; filename="' + name + '"');
    fs.createReadStream(p).pipe(res);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ── Delivery ──────────────────────────────────────────────────────────────────
// Delivery failing must never block a batch: both machines are on Wi-Fi and the
// cutting PC is sometimes off. Failure is recorded and Retry is the same endpoint;
// Download stays available throughout.
function deliverBatch(id) {
  const b = db.prepare('SELECT * FROM cutting_batches WHERE id=?').get(+id);
  if (!b) throw Object.assign(new Error('Batch not found'), { status: 404 });
  if (b.status === 'cancelled') throw Object.assign(new Error('This batch is cancelled'), { status: 409 });

  let archivePath = b.archive_path, fileName = b.file_name;
  if (!archivePath || !fileName || !fs.existsSync(archivePath)) {
    const g = generateFile(b.id);
    archivePath = g.archivePath; fileName = g.fileName;
  }
  const r = deliver(archivePath, fileName);
  if (r.ok) {
    db.prepare(`UPDATE cutting_batches SET delivery_status='delivered', delivered_at=datetime('now'),
                delivery_error=NULL, delivery_tries=delivery_tries+1 WHERE id=?`).run(b.id);
  } else {
    db.prepare(`UPDATE cutting_batches SET delivery_status='failed', delivery_error=?,
                delivery_tries=delivery_tries+1 WHERE id=?`).run(String(r.error).slice(0, 500), b.id);
  }
  const after = db.prepare('SELECT delivery_status, delivered_at, delivery_error, delivery_tries FROM cutting_batches WHERE id=?').get(b.id);
  return { ...r, file_name: fileName, ...after };
}

// POST /api/optima/batches/:id/deliver — also the Retry endpoint
router.post('/batches/:id/deliver', (req, res) => {
  try {
    const out = deliverBatch(req.params.id);
    // A failed delivery is a 200 with ok:false, not an HTTP error: the batch is
    // fine, only the network leg failed, and the UI needs the detail to show Retry.
    res.json(out);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ── Mark as cut: sheets used, stock reduced, cutting recorded ─────────────────
// Mirrors how an optimization deducts, deliberately and exactly. Two ledgers are
// written, both append-only:
//
//   slot_inventory          one row per deduction, qty negative, type 'deduct',
//                           ref_type 'batch',    ref_id = batch id
//   raw_sheet_transactions  one row PER SHEET,   qty negative, type 'batch_use',
//                           ref_id = batch id
//
// Why this shape and not something tidier:
//   * One ledger row per participating sheet, never one per batch. A multi-sheet
//     optimization once booked everything on the primary sheet and left a balance
//     of -50 (landmines.md §7).
//   * Both ledgers are written in the SAME transaction. They were historically two
//     independent write paths and drifted: ledger -2 / slots -1, slot rows with
//     qty 0, ledger-only cuts, 19 cuts never deducted from slots.
//   * Dedup on (type, ref_id, sheet_id), not ref_id alone — deduping on ref_id
//     alone is what made the second sheet of a split silently skip its row.
//   * type 'batch_use' goes in through THIS endpoint, never the generic
//     transactions POST, whose type whitelist rejection is what destroyed 35
//     purchase rows (landmines.md §6).
//   * ref_id alone is ambiguous now that two kinds of work write here, so every
//     dedup and reverse lookup must include `type`.
function slotBalance(slotId, sheetId) {
  const r = db.prepare('SELECT COALESCE(SUM(qty),0) AS bal FROM slot_inventory WHERE slot_id=? AND sheet_id=?')
    .get(slotId, sheetId);
  return r ? r.bal : 0;
}

// POST /api/optima/batches/:id/cut
// body: { deductions:[{slot_id, sheet_id, qty}], date?, notes?, record_cutting? }
// Pass dry_run:true to get exactly the rows that would be written, and nothing else.
router.post('/batches/:id/cut', (req, res) => {
  try {
    const b = db.prepare('SELECT * FROM cutting_batches WHERE id=?').get(+req.params.id);
    if (!b) return res.status(404).json({ error: 'Batch not found' });
    if (b.status === 'cut') return res.status(409).json({ error: 'This batch is already marked cut. Stock has been deducted once and must not be deducted again.' });
    if (b.status === 'cancelled') return res.status(409).json({ error: 'This batch is cancelled' });

    const deductions = (Array.isArray(req.body.deductions) ? req.body.deductions : [])
      .map(d => ({ slot_id: +d.slot_id, sheet_id: +d.sheet_id, qty: Number(d.qty) }))
      .filter(d => d.slot_id && d.sheet_id && d.qty > 0);
    if (!deductions.length) return res.status(400).json({ error: 'Add at least one slot deduction (which rack, which sheet, how many).' });

    // Balance check per deduction, with the same فضل exemption the optimizer path
    // uses: those sheets are virtual, legitimately negative, and must not block.
    for (const d of deductions) {
      const sheet = db.prepare('SELECT code, notes FROM raw_sheets WHERE id=?').get(d.sheet_id);
      const slot = db.prepare('SELECT name FROM a_frame_slots WHERE id=?').get(d.slot_id);
      if (!sheet) return res.status(400).json({ error: 'Unknown raw sheet ' + d.sheet_id });
      if (!slot) return res.status(400).json({ error: 'Unknown slot ' + d.slot_id });
      const isFadl = (sheet.code || '').includes('فضل') || (sheet.notes || '').includes('فضل')
                  || (slot.name || '').includes('فضل');
      if (!isFadl) {
        const bal = slotBalance(d.slot_id, d.sheet_id);
        if (d.qty > bal) return res.status(409).json({ error: 'Slot ' + slot.name + ' holds only ' + bal + ' sheet(s) of that type, and ' + d.qty + ' were entered.' });
      }
    }

    const bySheet = {};
    deductions.forEach(d => { bySheet[d.sheet_id] = (bySheet[d.sheet_id] || 0) + d.qty; });
    const sheetsUsed = deductions.reduce((a, d) => a + d.qty, 0);
    const date = String(req.body.date || '').slice(0, 10) || (() => {
      const d = new Date(), p2 = n => String(n).padStart(2, '0');
      return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());   // local parts
    })();
    const who = (req.user && (req.user.name || req.user.email)) || '';
    const label = b.batch_no + (b.file_name ? ' — ' + b.file_name : '');
    const recordCutting = req.body.record_cutting !== false;

    const pieces = db.prepare('SELECT piece_uid, order_num, order_id FROM cutting_batch_pieces WHERE batch_id=? AND active=1').all(b.id);
    const alreadyScanned = new Set(db.prepare(
      "SELECT DISTINCT piece_uid FROM scan_log WHERE action='done' AND process='cutting'").all().map(r => r.piece_uid));
    const toScan = recordCutting ? pieces.filter(p => !alreadyScanned.has(p.piece_uid)) : [];

    const plan = {
      batch_no: b.batch_no,
      sheets_used: sheetsUsed,
      slot_inventory: deductions.map(d => ({
        slot_id: d.slot_id, sheet_id: d.sheet_id, qty: -Math.abs(d.qty),
        type: 'deduct', ref_type: 'batch', ref_id: b.id, date
      })),
      raw_sheet_transactions: Object.keys(bySheet).map(sid => ({
        sheet_id: +sid, type: 'batch_use', qty: -Math.abs(bySheet[sid]), ref_id: b.id, ref_label: label, date
      })),
      cutting_scans: toScan.map(p => p.piece_uid),
      cutting_scans_skipped_already_done: pieces.length - toScan.length
    };
    if (req.body.dry_run) return res.json({ dry_run: true, plan });

    const txn = db.transaction(() => {
      const insSlot = db.prepare(`INSERT INTO slot_inventory (slot_id,sheet_id,qty,type,ref_type,ref_id,date,notes,created_by)
                                  VALUES (?,?,?,'deduct','batch',?,?,?,?)`);
      for (const d of deductions) {
        insSlot.run(d.slot_id, d.sheet_id, -Math.abs(d.qty), b.id, date, label, who);
      }
      const seen = db.prepare("SELECT id FROM raw_sheet_transactions WHERE type='batch_use' AND ref_id=? AND sheet_id=?");
      const insLedger = db.prepare(`INSERT INTO raw_sheet_transactions (sheet_id,type,qty,ref_id,ref_label,date,notes,created_by)
                                    VALUES (?,'batch_use',?,?,?,?,?,?)`);
      for (const sid of Object.keys(bySheet)) {
        if (seen.get(b.id, +sid)) continue;                       // dedup on (type, ref_id, sheet_id)
        insLedger.run(+sid, -Math.abs(bySheet[sid]), b.id, label, date, 'Optima batch cut', who);
      }
      if (toScan.length) {
        const insScan = db.prepare(`INSERT INTO scan_log (worker_id,worker_name,piece_uid,process,action,order_num,order_id)
                                    VALUES (?,?,?,'cutting','done',?,?)`);
        for (const p of toScan) {
          insScan.run((req.user && req.user.id) || 1, who, p.piece_uid, p.order_num, p.order_id);
        }
      }
      db.prepare(`UPDATE cutting_batches SET status='cut', cut_at=datetime('now'), cut_by=?, sheets_used=?,
                  notes=CASE WHEN ?<>'' THEN ? ELSE notes END WHERE id=?`)
        .run(who, sheetsUsed, String(req.body.notes || ''), String(req.body.notes || ''), b.id);
    });
    txn();

    res.json({ ok: true, ...plan, ...batchDetail(b.id) });
  } catch (e) {
    console.error('[optima batch cut]', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
