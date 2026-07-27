// routes/cutting.js ? Cutting Movements (partial cutting progress for optimizations)
// Phase 2 backend. Records dated cutting movements against an optimization,
// deducting BOTH stock ledgers (slot_inventory + raw_sheet_transactions) per
// movement with NO dedup, and auto-evaluates opt status (pending/in_progress/done).
const router = require('express').Router();
const db     = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
router.use(requireAuth);

// Remnant marker = the Arabic offcut word stored in remnant sheet codes/notes/slot
// names. Kept as \u escapes so this source stays pure ASCII (safe ascii deploy).
const REMNANT_MARK = '\u0641\u0636\u0644';

// ?? Schema (idempotent; mirrors the Phase 1 migration) ??????????????????????
try {
  db.prepare(`CREATE TABLE IF NOT EXISTS cutting_movements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    opt_file_id INTEGER REFERENCES opt_files(id),
    movement_date TEXT NOT NULL,
    sheets_total REAL NOT NULL DEFAULT 0,
    sqm_total REAL NOT NULL DEFAULT 0,
    kind TEXT NOT NULL DEFAULT 'cut',
    notes TEXT DEFAULT '',
    created_by TEXT DEFAULT '',
    created_at DATETIME DEFAULT (datetime('now','localtime'))
  )`).run();
  db.prepare(`CREATE TABLE IF NOT EXISTS cutting_movement_slots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    movement_id INTEGER NOT NULL REFERENCES cutting_movements(id),
    slot_id INTEGER NOT NULL REFERENCES a_frame_slots(id),
    sheet_id INTEGER NOT NULL REFERENCES raw_sheets(id),
    sheets REAL NOT NULL
  )`).run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_cutmove_opt ON cutting_movements(opt_file_id)').run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_cutmove_date ON cutting_movements(movement_date)').run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_cutmoveslot_mv ON cutting_movement_slots(movement_id)').run();
  try { db.prepare('ALTER TABLE opt_files ADD COLUMN total_sheets INTEGER').run(); } catch(e){}
} catch(e){ console.warn('[cutting init]', e.message); }

// ?? Helpers ?????????????????????????????????????????????????????????????????
function plannedSheetCount(opt){
  try{
    const results = typeof opt.results==='string' ? JSON.parse(opt.results) : opt.results;
    const arr = Array.isArray(results) ? results : (results && results.results) || [];
    return arr.length || 0;
  }catch(e){ return 0; }
}
function optTarget(opt){
  return (opt.total_sheets!=null) ? opt.total_sheets : plannedSheetCount(opt);
}
function optCutSheets(optId){
  const r = db.prepare("SELECT COALESCE(SUM(sheets_total),0) AS s FROM cutting_movements WHERE opt_file_id=? AND kind='cut'").get(optId);
  return r ? r.s : 0;
}
// Re-evaluate + persist opt status from movement sum vs target.
function recomputeOptStatus(optId, prevStatus){
  const opt = db.prepare('SELECT * FROM opt_files WHERE id=?').get(optId);
  if(!opt) return null;
  const target = optTarget(opt);
  const done   = optCutSheets(optId);
  let status;
  if(target>0 && done>=target) status='done';
  else if(done>0)              status='in_progress';
  else                         status='pending';
  const was = (prevStatus!=null) ? prevStatus : opt.status;
  const justClosed = (status==='done' && was!=='done');
  if(status==='done'){
    db.prepare("UPDATE opt_files SET status='done', completed_at=COALESCE(completed_at, datetime('now','localtime')), updated_at=datetime('now') WHERE id=?").run(optId);
  } else {
    db.prepare("UPDATE opt_files SET status=?, completed_at=NULL, updated_at=datetime('now') WHERE id=?").run(status, optId);
  }
  return { status, done, target, justClosed };
}

// ?? POST /api/cutting/movements ? record one cutting movement ????????????????
// body: { opt_file_id, movement_date, slots:[{slot_id,sheet_id,sheets}], notes }
router.post('/movements', requireAdmin, (req,res)=>{
  try{
    const { opt_file_id, movement_date, slots, notes } = req.body;
    if(!opt_file_id) return res.status(400).json({error:'opt_file_id required'});
    if(!Array.isArray(slots)||!slots.length) return res.status(400).json({error:'slots required'});
    const date = movement_date || new Date().toISOString().slice(0,10);
    const opt = db.prepare('SELECT * FROM opt_files WHERE id=?').get(+opt_file_id);
    if(!opt) return res.status(404).json({error:'Optimization not found'});

    let sheetsTotal=0, sqmTotal=0;
    const lines=[];
    for(const s of slots){
      const slot_id=+s.slot_id, sheet_id=+s.sheet_id, sheets=Math.abs(+s.sheets);
      if(!slot_id||!sheet_id||!sheets) continue;
      const sheet = db.prepare('SELECT id,code,notes,w,h FROM raw_sheets WHERE id=?').get(sheet_id);
      const slot  = db.prepare('SELECT id,name FROM a_frame_slots WHERE id=?').get(slot_id);
      if(!sheet||!slot) throw new Error('Invalid slot or sheet in line');
      const isRemnant = ((sheet.code||'').includes(REMNANT_MARK) || (sheet.notes||'').includes(REMNANT_MARK) || (slot.name||'').includes(REMNANT_MARK));
      if(!isRemnant){
        const bal = db.prepare('SELECT COALESCE(SUM(qty),0) AS b FROM slot_inventory WHERE slot_id=? AND sheet_id=?').get(slot_id,sheet_id).b;
        if(sheets>bal) throw new Error('Slot '+slot.name+' has only '+bal+' sheets of '+sheet.code);
      }
      sheetsTotal += sheets;
      sqmTotal    += (Number(sheet.w)||0)*(Number(sheet.h)||0)/1e6*sheets;
      lines.push({slot_id,sheet_id,sheets});
    }
    if(!lines.length) return res.status(400).json({error:'no valid slot lines'});

    const optName = opt.name || ('Opt #'+opt.id);
    const who = (req.user && req.user.name) || '';

    const run = db.transaction(()=>{
      const m = db.prepare("INSERT INTO cutting_movements (opt_file_id,movement_date,sheets_total,sqm_total,kind,notes,created_by) VALUES (?,?,?,?,'cut',?,?)")
        .run(+opt_file_id, date, sheetsTotal, sqmTotal, notes||'', who);
      const mid = m.lastInsertRowid;
      const tag = 'Cutting movement #'+mid;
      const insLine    = db.prepare('INSERT INTO cutting_movement_slots (movement_id,slot_id,sheet_id,sheets) VALUES (?,?,?,?)');
      const insSlotInv = db.prepare("INSERT INTO slot_inventory (slot_id,sheet_id,qty,type,ref_type,ref_id,date,notes,created_by) VALUES (?,?,?,'deduct','optimization',?,?,?,?)");
      const insRawTx   = db.prepare("INSERT INTO raw_sheet_transactions (sheet_id,type,qty,ref_id,ref_label,date,notes,created_by) VALUES (?,'optimization_use',?,?,?,?,?,?)");
      const perSheet={};
      for(const L of lines){
        insLine.run(mid, L.slot_id, L.sheet_id, L.sheets);
        insSlotInv.run(L.slot_id, L.sheet_id, -Math.abs(L.sheets), +opt_file_id, date, tag, who);
        perSheet[L.sheet_id]=(perSheet[L.sheet_id]||0)+L.sheets;
      }
      for(const sid in perSheet){
        insRawTx.run(+sid, -Math.abs(perSheet[sid]), +opt_file_id, optName, date, tag, who);
      }
      return mid;
    });
    const mid = run();
    const progress = recomputeOptStatus(+opt_file_id, opt.status);
    res.status(201).json({ ok:true, movement_id:mid, sheets_total:sheetsTotal, sqm_total:sqmTotal, progress });
  }catch(e){ res.status(400).json({error:e.message}); }
});

// ?? GET /api/cutting/movements?opt_file_id=&from=&to= ???????????????????????
router.get('/movements', (req,res)=>{
  try{
    const { opt_file_id, from, to } = req.query;
    let sql='SELECT m.*, o.name AS opt_name FROM cutting_movements m LEFT JOIN opt_files o ON o.id=m.opt_file_id WHERE 1=1';
    const args=[];
    if(opt_file_id){ sql+=' AND m.opt_file_id=?'; args.push(+opt_file_id); }
    if(from){ sql+=' AND m.movement_date>=?'; args.push(from); }
    if(to){ sql+=' AND m.movement_date<=?'; args.push(to); }
    sql+=' ORDER BY m.movement_date DESC, m.id DESC';
    const rows=db.prepare(sql).all(...args);
    const lineStmt=db.prepare('SELECT cms.*, rs.code AS sheet_code, afs.name AS slot_name FROM cutting_movement_slots cms LEFT JOIN raw_sheets rs ON rs.id=cms.sheet_id LEFT JOIN a_frame_slots afs ON afs.id=cms.slot_id WHERE cms.movement_id=?');
    for(const r of rows){ r.slots = lineStmt.all(r.id); }
    res.json(rows);
  }catch(e){ res.status(500).json({error:e.message}); }
});

// ?? GET /api/cutting/opt/:id/progress ???????????????????????????????????????
router.get('/opt/:id/progress', (req,res)=>{
  try{
    const opt=db.prepare('SELECT * FROM opt_files WHERE id=?').get(+req.params.id);
    if(!opt) return res.status(404).json({error:'Not found'});
    res.json({ opt_file_id:opt.id, status:opt.status, target:optTarget(opt), done:optCutSheets(opt.id), planned:plannedSheetCount(opt) });
  }catch(e){ res.status(500).json({error:e.message}); }
});

// ?? DELETE /api/cutting/movements/:id ? reverse a movement ??????????????????
router.delete('/movements/:id', requireAdmin, (req,res)=>{
  try{
    const mid=+req.params.id;
    const m=db.prepare('SELECT * FROM cutting_movements WHERE id=?').get(mid);
    if(!m) return res.status(404).json({error:'Not found'});
    const optId=m.opt_file_id;
    const tag='Cutting movement #'+mid;
    const run=db.transaction(()=>{
      if(m.kind==='cut' && optId!=null){
        db.prepare("DELETE FROM raw_sheet_transactions WHERE type='optimization_use' AND ref_id=? AND notes=?").run(optId, tag);
        db.prepare("DELETE FROM slot_inventory WHERE type='deduct' AND ref_type='optimization' AND ref_id=? AND notes=?").run(optId, tag);
      }
      db.prepare('DELETE FROM cutting_movement_slots WHERE movement_id=?').run(mid);
      db.prepare('DELETE FROM cutting_movements WHERE id=?').run(mid);
    });
    run();
    const progress = (optId!=null) ? recomputeOptStatus(optId, null) : null;
    res.json({ ok:true, progress });
  }catch(e){ res.status(400).json({error:e.message}); }
});

// ?? GET /api/cutting/daily?from=&to= ? sheets + sqm per day (both kinds) ?????
router.get('/daily', (req,res)=>{
  try{
    const { from, to } = req.query;
    // Sheets count excludes virtual remnant sheets (\u0641\u0636\u0644 = label-only pseudo-sheets); sqm/movements stay full
    const FADL_CASE = `CASE WHEN (
      EXISTS(SELECT 1 FROM opt_files o JOIN raw_sheets r ON r.id=o.raw_sheet_id WHERE o.id=cm.opt_file_id AND (r.code LIKE '%\u0641\u0636\u0644%' OR r.notes LIKE '%\u0641\u0636\u0644%'))
      OR EXISTS(SELECT 1 FROM opt_files o2 WHERE o2.id=cm.opt_file_id AND o2.raw_sheet_snap LIKE '%\u0641\u0636\u0644%')
      OR EXISTS(SELECT 1 FROM cutting_movement_slots x JOIN raw_sheets r2 ON r2.id=x.sheet_id WHERE x.movement_id=cm.id AND (r2.code LIKE '%\u0641\u0636\u0644%' OR r2.notes LIKE '%\u0641\u0636\u0644%'))
    ) THEN 0 ELSE cm.sheets_total END`;
    let sql='SELECT cm.movement_date AS date, COALESCE(SUM('+FADL_CASE+'),0) AS sheets, COALESCE(SUM(cm.sqm_total),0) AS sqm, COUNT(*) AS movements FROM cutting_movements cm WHERE 1=1';
    const args=[];
    if(from){ sql+=' AND cm.movement_date>=?'; args.push(from); }
    if(to){ sql+=' AND cm.movement_date<=?'; args.push(to); }
    sql+=' GROUP BY cm.movement_date ORDER BY cm.movement_date';
    res.json(db.prepare(sql).all(...args));
  }catch(e){ res.status(500).json({error:e.message}); }
});

// GET /api/cutting/progress -- bulk { opt_file_id: sheets_cut } for opts with cut movements
router.get('/progress', (req,res)=>{
  try{
    const rows=db.prepare("SELECT opt_file_id, COALESCE(SUM(sheets_total),0) AS done FROM cutting_movements WHERE kind='cut' AND opt_file_id IS NOT NULL GROUP BY opt_file_id").all();
    const map={}; for(const r of rows) map[r.opt_file_id]=r.done;
    res.json(map);
  }catch(e){ res.status(500).json({error:e.message}); }
});

module.exports = router;
