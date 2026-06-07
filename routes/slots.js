// routes/slots.js — A-Frame Slot Management
const router = require('express').Router();
const db     = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
router.use(requireAuth);

// ── Schema ────────────────────────────────────────────────────────────────
try {
  db.prepare(`CREATE TABLE IF NOT EXISTS a_frame_slots (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE,  -- e.g. A1L, A1R
    frame      TEXT NOT NULL,         -- e.g. A1
    side       TEXT NOT NULL,         -- L or R
    notes      TEXT DEFAULT '',
    active     INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT (datetime('now','localtime'))
  )`).run();

  db.prepare(`CREATE TABLE IF NOT EXISTS slot_inventory (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    slot_id    INTEGER NOT NULL REFERENCES a_frame_slots(id),
    sheet_id   INTEGER NOT NULL REFERENCES raw_sheets(id),
    qty        REAL NOT NULL,         -- positive=in, negative=out
    type       TEXT NOT NULL,         -- 'assign' | 'deduct'
    ref_type   TEXT DEFAULT '',       -- 'transaction' | 'optimization'
    ref_id     INTEGER DEFAULT NULL,  -- tx_id or opt_file_id
    date       TEXT NOT NULL,
    notes      TEXT DEFAULT '',
    created_by TEXT DEFAULT '',
    created_at DATETIME DEFAULT (datetime('now','localtime'))
  )`).run();
} catch(e) { console.warn('[slots init]', e.message); }

// ── Helpers ───────────────────────────────────────────────────────────────
function slotBalance(slotId, sheetId) {
  const r = db.prepare(
    'SELECT COALESCE(SUM(qty),0) AS bal FROM slot_inventory WHERE slot_id=? AND sheet_id=?'
  ).get(slotId, sheetId);
  return r ? r.bal : 0;
}

function slotContents(slotId) {
  return db.prepare(`
    SELECT si.sheet_id, rs.code, rs.notes AS sheet_notes, rs.thickness, rs.color, rs.glass_type,
           COALESCE(SUM(si.qty),0) AS qty
    FROM slot_inventory si
    JOIN raw_sheets rs ON rs.id=si.sheet_id
    WHERE si.slot_id=?
    GROUP BY si.sheet_id
    HAVING COALESCE(SUM(si.qty),0) != 0
  `).all(slotId);
}

// ── Slots CRUD ────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  try {
    const slots = db.prepare('SELECT * FROM a_frame_slots ORDER BY frame, side').all();
    const result = slots.map(s => ({
      ...s,
      contents: slotContents(s.id)
    }));
    res.json(result);
  } catch(e) { res.status(500).json({error:e.message}); }
});

router.post('/', requireAdmin, (req, res) => {
  try {
    const { name, frame, side, notes } = req.body;
    if(!name||!frame||!side) return res.status(400).json({error:'name, frame, side required'});
    const r = db.prepare(
      'INSERT INTO a_frame_slots (name,frame,side,notes) VALUES (?,?,?,?)'
    ).run(name.toUpperCase().trim(), frame.toUpperCase().trim(), side.toUpperCase().trim(), notes||'');
    res.status(201).json(db.prepare('SELECT * FROM a_frame_slots WHERE id=?').get(r.lastInsertRowid));
  } catch(e) { res.status(500).json({error:e.message}); }
});

router.put('/:id', requireAdmin, (req, res) => {
  try {
    const { name, frame, side, notes, active } = req.body;
    db.prepare(
      'UPDATE a_frame_slots SET name=?,frame=?,side=?,notes=?,active=? WHERE id=?'
    ).run(name.toUpperCase().trim(), frame.toUpperCase().trim(), side.toUpperCase().trim(), notes||'', active??1, +req.params.id);
    res.json(db.prepare('SELECT * FROM a_frame_slots WHERE id=?').get(+req.params.id));
  } catch(e) { res.status(500).json({error:e.message}); }
});

router.delete('/:id', requireAdmin, (req, res) => {
  try {
    const hasInventory = db.prepare('SELECT COUNT(*) AS c FROM slot_inventory WHERE slot_id=?').get(+req.params.id);
    if(hasInventory.c > 0) return res.status(400).json({error:'Cannot delete slot with inventory history'});
    db.prepare('DELETE FROM a_frame_slots WHERE id=?').run(+req.params.id);
    res.json({ok:true});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ── Slot Inventory ────────────────────────────────────────────────────────

// GET /api/slots/all-inventory — all slot contents summary (MUST be before /:id routes)
router.get('/all-inventory', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT si.slot_id, afs.name AS slot_name, afs.frame, afs.side,
             si.sheet_id, rs.code AS sheet_code, rs.notes AS sheet_notes,
             rs.thickness, rs.color, rs.glass_type,
             COALESCE(SUM(si.qty),0) AS qty
      FROM slot_inventory si
      JOIN a_frame_slots afs ON afs.id=si.slot_id
      JOIN raw_sheets rs ON rs.id=si.sheet_id
      GROUP BY si.slot_id, si.sheet_id
      HAVING COALESCE(SUM(si.qty),0) > 0
      ORDER BY afs.name, rs.code
    `).all();
    res.json(rows);
  } catch(e) { res.status(500).json({error:e.message}); }
});

// PUT /api/slots/inventory/:txId — edit a slot inventory entry
router.put('/inventory/:txId', requireAdmin, (req, res) => {
  try {
    const tx = db.prepare('SELECT * FROM slot_inventory WHERE id=?').get(+req.params.txId);
    if(!tx) return res.status(404).json({error:'Not found'});
    const { qty, date, notes } = req.body;
    db.prepare('UPDATE slot_inventory SET qty=COALESCE(?,qty), date=COALESCE(?,date), notes=COALESCE(?,notes) WHERE id=?')
      .run(qty!=null?+qty:null, date||null, notes!=null?notes:null, +req.params.txId);
    res.json(db.prepare('SELECT * FROM slot_inventory WHERE id=?').get(+req.params.txId));
  } catch(e) { res.status(500).json({error:e.message}); }
});

// DELETE /api/slots/inventory/:txId — delete a slot inventory entry (MUST be before /:id routes)
router.delete('/inventory/:txId', requireAdmin, (req, res) => {
  try {
    const tx = db.prepare('SELECT * FROM slot_inventory WHERE id=?').get(+req.params.txId);
    if(!tx) return res.status(404).json({error:'Not found'});
    db.prepare('DELETE FROM slot_inventory WHERE id=?').run(+req.params.txId);
    res.json({ok:true});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// POST /api/slots/deduct — deduct from slot(s) for optimization (MUST be before /:id routes)
router.post('/deduct', requireAdmin, (req, res) => {
  try {
    const { deductions, opt_file_id, opt_name, date } = req.body;
    // deductions = [{slot_id, sheet_id, qty}, ...]
    if(!deductions||!deductions.length) return res.status(400).json({error:'deductions required'});

    const results = [];
    const insertTx = db.transaction(() => {
      for(const d of deductions){
        if(!d.slot_id||!d.sheet_id||!d.qty) continue;
        // Check slot has enough — skip for remnant/offcut sheets (name contains فضل)
        const _sheet = db.prepare('SELECT code, notes FROM raw_sheets WHERE id=?').get(d.sheet_id);
        const _slot  = db.prepare('SELECT name FROM a_frame_slots WHERE id=?').get(d.slot_id);
        const _isRemnant = ((_sheet&&((_sheet.code||'').includes('فضل')||(_sheet.notes||'').includes('فضل'))))||
                           (_slot&&(_slot.name||'').includes('فضل'));
        if(!_isRemnant){
          const bal = slotBalance(d.slot_id, d.sheet_id);
          if(d.qty > bal) throw new Error(`Slot has only ${bal} sheets of this type`);
        }
        const r = db.prepare(
          'INSERT INTO slot_inventory (slot_id,sheet_id,qty,type,ref_type,ref_id,date,notes,created_by) VALUES (?,?,?,?,?,?,?,?,?)'
        ).run(d.slot_id, d.sheet_id, -Math.abs(d.qty), 'deduct', 'optimization', opt_file_id||null,
          date||new Date().toISOString().slice(0,10),
          opt_name||('Opt #'+opt_file_id), req.user?.name||'');
        results.push(db.prepare('SELECT * FROM slot_inventory WHERE id=?').get(r.lastInsertRowid));
      }
    });
    insertTx();
    res.status(201).json({ok:true, results});
  } catch(e) { res.status(400).json({error:e.message}); }
});

// GET /api/slots/:id/inventory — full history for one slot
router.get('/:id/inventory', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT si.*, rs.code AS sheet_code, rs.notes AS sheet_notes,
             rs.thickness, rs.color, rs.glass_type
      FROM slot_inventory si
      JOIN raw_sheets rs ON rs.id=si.sheet_id
      WHERE si.slot_id=?
      ORDER BY si.date DESC, si.id DESC
    `).all(+req.params.id);
    res.json(rows);
  } catch(e) { res.status(500).json({error:e.message}); }
});

// POST /api/slots/:id/assign — assign stock to slot
router.post('/:id/assign', requireAdmin, (req, res) => {
  try {
    const { sheet_id, qty, date, notes, ref_type, ref_id } = req.body;
    if(!sheet_id||!qty||!date) return res.status(400).json({error:'sheet_id, qty, date required'});
    if(qty <= 0) return res.status(400).json({error:'qty must be positive for assignment'});

    // unassigned = total stock balance - total already in slots (net)
    const txBal      = db.prepare('SELECT COALESCE(SUM(qty),0) AS bal FROM raw_sheet_transactions WHERE sheet_id=?').get(+sheet_id);
    const totalInSlots = db.prepare('SELECT COALESCE(SUM(qty),0) AS bal FROM slot_inventory WHERE sheet_id=?').get(+sheet_id);
    const unassigned = (txBal?.bal||0) - (totalInSlots?.bal||0);
    if(qty > unassigned) return res.status(400).json({error:`Only ${unassigned} sheets available to assign`});

    const r = db.prepare(
      'INSERT INTO slot_inventory (slot_id,sheet_id,qty,type,ref_type,ref_id,date,notes,created_by) VALUES (?,?,?,?,?,?,?,?,?)'
    ).run(+req.params.id, +sheet_id, +qty, 'assign', ref_type||'', ref_id||null, date, notes||'', req.user?.name||'');
    res.status(201).json(db.prepare('SELECT * FROM slot_inventory WHERE id=?').get(r.lastInsertRowid));
  } catch(e) { res.status(500).json({error:e.message}); }
});

// GET /api/slots/movements — unified movement log: slot_inventory + raw_sheet_transactions
router.get('/movements', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT
        si.id                    AS row_id,
        si.date,
        si.qty,
        si.type                  AS move_type,
        si.ref_type,
        si.ref_id,
        si.notes,
        si.created_by,
        si.created_at            AS row_ts,
        'slot'                   AS source,
        afs.name                 AS slot_name,
        rs.code                  AS sheet_code,
        rs.notes                 AS sheet_notes,
        rs.thickness,
        rs.color,
        rs.glass_type,
        po.po_number,
        opf.name                 AS opt_name
      FROM slot_inventory si
      JOIN a_frame_slots afs ON afs.id = si.slot_id
      JOIN raw_sheets rs ON rs.id = si.sheet_id
      LEFT JOIN purchase_orders po
        ON (si.ref_type='transaction' OR si.ref_type='purchase') AND si.ref_id = po.id
      LEFT JOIN opt_files opf
        ON si.ref_type='optimization' AND si.ref_id = opf.id

      UNION ALL

      SELECT
        rst.id                   AS row_id,
        rst.date,
        rst.qty,
        rst.type                 AS move_type,
        rst.type                 AS ref_type,
        rst.ref_id,
        rst.notes,
        rst.created_by,
        rst.created_at           AS row_ts,
        'ledger'                 AS source,
        NULL                     AS slot_name,
        rs.code                  AS sheet_code,
        rs.notes                 AS sheet_notes,
        rs.thickness,
        rs.color,
        rs.glass_type,
        po.po_number,
        NULL                     AS opt_name
      FROM raw_sheet_transactions rst
      JOIN raw_sheets rs ON rs.id = rst.sheet_id
      LEFT JOIN purchase_orders po ON rst.type='purchase' AND rst.ref_id = po.id

      ORDER BY date DESC, row_ts DESC
    `).all();
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
