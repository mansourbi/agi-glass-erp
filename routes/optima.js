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
const { validateOptimaName } = require('../optima-text');

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

// 4. Batch membership. Authoritative, independent of labels. Stores the FINISHED
// size only — the ERP does not know the cut size in this flow (decision 11).
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
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_cbp_batch ON cutting_batch_pieces(batch_id)').run();
  // Exclusivity at the DATABASE, not the UI: 55 piece UIDs already sit in two opt
  // files each because the optimizer's equivalent check is dead code (landmines §9).
  db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_cbp_active_uid
              ON cutting_batch_pieces(piece_uid) WHERE active = 1`).run();
} catch (e) { console.warn('[optima migrate] cutting_batch_pieces:', e.message); }

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

module.exports = router;
