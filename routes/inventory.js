// routes/inventory.js - spare parts / tools / consumables warehouse
const router = require('express').Router();
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
router.use(requireAuth);

// -- migrations --------------------------------------------------------------
try { db.prepare(`CREATE TABLE IF NOT EXISTS inv_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE, name TEXT NOT NULL, name_ar TEXT,
  category TEXT DEFAULT 'spare_part', spec TEXT, unit TEXT DEFAULT 'pc',
  criticality TEXT DEFAULT 'normal', lead_time_days INTEGER, min_stock REAL, reorder_level REAL,
  location TEXT, unit_cost_jod REAL DEFAULT 0, photo TEXT, notes TEXT, active INTEGER DEFAULT 1,
  created_by TEXT, created_at DATETIME DEFAULT (datetime('now','localtime')))`).run(); } catch(e) {}
try { db.prepare(`CREATE TABLE IF NOT EXISTS inv_item_machines (
  id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL, machine_id INTEGER NOT NULL,
  station TEXT, UNIQUE(item_id, machine_id))`).run(); } catch(e) {}
try { db.prepare(`CREATE TABLE IF NOT EXISTS inv_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL, kind TEXT NOT NULL,
  qty REAL NOT NULL, unit_cost_jod REAL, ref_type TEXT, ref_id INTEGER,
  machine_id INTEGER, worker_id INTEGER, worker_name TEXT, note TEXT,
  date TEXT, created_by TEXT, created_at DATETIME DEFAULT (datetime('now','localtime')))`).run(); } catch(e) {}
try { db.prepare(`CREATE TABLE IF NOT EXISTS inv_invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_no TEXT, supplier TEXT, date TEXT,
  goods_currency TEXT DEFAULT 'JOD', goods_to_jod_rate REAL DEFAULT 1,
  extra_costs_jod REAL DEFAULT 0, extra_costs_note TEXT,
  total_goods_jod REAL DEFAULT 0, total_landed_jod REAL DEFAULT 0,
  notes TEXT, created_by TEXT, created_at DATETIME DEFAULT (datetime('now','localtime')))`).run(); } catch(e) {}
try { db.prepare(`CREATE TABLE IF NOT EXISTS inv_invoice_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_id INTEGER NOT NULL, item_id INTEGER NOT NULL,
  qty REAL NOT NULL, unit_price REAL NOT NULL, line_goods REAL,
  landed_unit_jod REAL, line_landed_jod REAL)`).run(); } catch(e) {}
try { db.prepare(`CREATE TABLE IF NOT EXISTS inv_custody (
  id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL, worker_id INTEGER NOT NULL,
  worker_name TEXT, qty REAL NOT NULL, issued_at TEXT, issued_by TEXT,
  status TEXT DEFAULT 'held', returned_at TEXT, condition_note TEXT,
  created_at DATETIME DEFAULT (datetime('now','localtime')))`).run(); } catch(e) {}

const STOCK_SQL = `COALESCE((SELECT SUM(CASE
  WHEN kind IN ('in','custody_return') THEN qty
  WHEN kind='adjust' THEN qty
  ELSE -qty END) FROM inv_movements WHERE item_id=i.id),0)`;

function stockOf(itemId){
  return db.prepare(`SELECT COALESCE(SUM(CASE
    WHEN kind IN ('in','custody_return') THEN qty
    WHEN kind='adjust' THEN qty
    ELSE -qty END),0) s FROM inv_movements WHERE item_id=?`).get(itemId).s;
}
function genCode(){
  const r = db.prepare("SELECT code FROM inv_items WHERE code LIKE 'SP-%'").all()
    .map(x=>+String(x.code).replace('SP-','')).filter(n=>!isNaN(n));
  const n = (r.length ? Math.max(...r) : 0) + 1;
  return 'SP-' + String(n).padStart(4,'0');
}
function applyWac(itemId, qty, unitCostJod){
  if(unitCostJod==null || !(qty>0)) return;
  const it = db.prepare('SELECT unit_cost_jod FROM inv_items WHERE id=?').get(itemId);
  const before = stockOf(itemId); // called BEFORE inserting the movement
  const oldWac = +it.unit_cost_jod||0;
  const wac = (before>0 && oldWac>0) ? ((before*oldWac + qty*unitCostJod) / (before+qty)) : unitCostJod;
  db.prepare('UPDATE inv_items SET unit_cost_jod=? WHERE id=?').run(+wac.toFixed(4), itemId);
}
function addMovement(m){
  return db.prepare(`INSERT INTO inv_movements (item_id,kind,qty,unit_cost_jod,ref_type,ref_id,machine_id,worker_id,worker_name,note,date,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    m.item_id, m.kind, m.qty, m.unit_cost_jod??null, m.ref_type||null, m.ref_id||null,
    m.machine_id||null, m.worker_id||null, m.worker_name||null, m.note||null,
    m.date || new Date().toISOString().slice(0,10), m.created_by);
}

// -- alerts / movements / custody / invoices (specific before :param) --------
router.get('/alerts', (req,res)=>{
  try{
    const rows = db.prepare(`SELECT i.*, ${STOCK_SQL} AS stock FROM inv_items i WHERE i.active=1`).all()
      .filter(i=>i.min_stock!=null && i.stock <= i.min_stock);
    res.json(rows);
  }catch(e){ res.status(500).json({error:e.message}); }
});

router.get('/movements', (req,res)=>{
  try{
    const { item_id, worker_id, machine_id, kind, from, to, limit } = req.query;
    let sql = `SELECT m.*, i.code AS item_code, i.name AS item_name, i.unit FROM inv_movements m JOIN inv_items i ON i.id=m.item_id WHERE 1=1`;
    const p=[];
    if(item_id){ sql+=' AND m.item_id=?'; p.push(+item_id); }
    if(worker_id){ sql+=' AND m.worker_id=?'; p.push(+worker_id); }
    if(machine_id){ sql+=' AND m.machine_id=?'; p.push(+machine_id); }
    if(kind){ sql+=' AND m.kind=?'; p.push(kind); }
    if(from){ sql+=' AND m.date>=?'; p.push(from); }
    if(to){ sql+=' AND m.date<=?'; p.push(to); }
    sql+=' ORDER BY m.date DESC, m.id DESC LIMIT '+(Math.min(1000, +limit||300));
    res.json(db.prepare(sql).all(...p));
  }catch(e){ res.status(500).json({error:e.message}); }
});

// manual movement: in (no invoice) / out (consume) / adjust / discard
router.post('/movements', (req,res)=>{
  try{
    const { item_id, kind, qty, unit_cost_jod, machine_id, worker_id, note, date } = req.body;
    if(!item_id || !kind || !qty) return res.status(400).json({error:'item_id, kind, qty required'});
    if(!['in','out','adjust','discard'].includes(kind)) return res.status(400).json({error:'kind must be in|out|adjust|discard'});
    if(['in','adjust'].includes(kind) && !note) return res.status(400).json({error:'note required for '+kind});
    if(['out','discard'].includes(kind)){
      const s = stockOf(+item_id);
      if(+qty > s) return res.status(400).json({error:'Insufficient stock: '+s});
    }
    let wname = null;
    if(worker_id){ wname = (db.prepare('SELECT name FROM workers WHERE id=?').get(+worker_id)||{}).name; }
    if(kind==='in') applyWac(+item_id, +qty, unit_cost_jod!=null?+unit_cost_jod:null);
    const r = addMovement({ item_id:+item_id, kind, qty:+qty, unit_cost_jod: unit_cost_jod!=null?+unit_cost_jod:null,
      machine_id: machine_id?+machine_id:null, worker_id: worker_id?+worker_id:null, worker_name:wname,
      note, date, created_by: req.user.name });
    res.status(201).json({id:r.lastInsertRowid, stock: stockOf(+item_id)});
  }catch(e){ res.status(500).json({error:e.message}); }
});

router.get('/custody', (req,res)=>{
  try{
    const { status, worker_id } = req.query;
    let sql=`SELECT c.*, i.code AS item_code, i.name AS item_name, i.unit FROM inv_custody c JOIN inv_items i ON i.id=c.item_id WHERE 1=1`;
    const p=[];
    if(status){ sql+=' AND c.status=?'; p.push(status); }
    if(worker_id){ sql+=' AND c.worker_id=?'; p.push(+worker_id); }
    sql+=' ORDER BY c.issued_at DESC, c.id DESC';
    res.json(db.prepare(sql).all(...p));
  }catch(e){ res.status(500).json({error:e.message}); }
});
router.post('/custody', requireAdmin, (req,res)=>{
  try{
    const { item_id, worker_id, qty, condition_note, issued_at } = req.body;
    if(!item_id || !worker_id || !qty) return res.status(400).json({error:'item_id, worker_id, qty required'});
    const s = stockOf(+item_id);
    if(+qty > s) return res.status(400).json({error:'Insufficient stock: '+s});
    const w = db.prepare('SELECT name FROM workers WHERE id=?').get(+worker_id);
    const tx = db.transaction(()=>{
      const c = db.prepare(`INSERT INTO inv_custody (item_id,worker_id,worker_name,qty,issued_at,issued_by,condition_note)
        VALUES (?,?,?,?,?,?,?)`).run(+item_id, +worker_id, w?.name||'', +qty,
        issued_at||new Date().toISOString().slice(0,10), req.user.name, condition_note||null);
      addMovement({ item_id:+item_id, kind:'custody_out', qty:+qty, ref_type:'custody', ref_id:c.lastInsertRowid,
        worker_id:+worker_id, worker_name:w?.name||'', note:'Custody issued', created_by:req.user.name });
      return c.lastInsertRowid;
    });
    res.status(201).json({id:tx()});
  }catch(e){ res.status(500).json({error:e.message}); }
});
router.put('/custody/:id/close', requireAdmin, (req,res)=>{
  try{
    const { outcome, condition_note } = req.body; // returned | consumed | lost
    if(!['returned','consumed','lost'].includes(outcome)) return res.status(400).json({error:'outcome must be returned|consumed|lost'});
    const c = db.prepare('SELECT * FROM inv_custody WHERE id=?').get(+req.params.id);
    if(!c) return res.status(404).json({error:'Not found'});
    if(c.status!=='held') return res.status(400).json({error:'Custody already '+c.status});
    const today = new Date().toISOString().slice(0,10);
    const tx = db.transaction(()=>{
      db.prepare('UPDATE inv_custody SET status=?, returned_at=?, condition_note=COALESCE(?,condition_note) WHERE id=?')
        .run(outcome, today, condition_note||null, c.id);
      if(outcome==='returned'){
        addMovement({ item_id:c.item_id, kind:'custody_return', qty:c.qty, ref_type:'custody', ref_id:c.id,
          worker_id:c.worker_id, worker_name:c.worker_name, note:'Custody returned', created_by:req.user.name });
      }
      // consumed/lost: custody_out already removed it from stock - record the outcome only
    });
    tx();
    res.json({ok:true});
  }catch(e){ res.status(500).json({error:e.message}); }
});

router.get('/invoices', (req,res)=>{
  try{
    const inv = db.prepare('SELECT * FROM inv_invoices ORDER BY date DESC, id DESC').all();
    res.json(inv);
  }catch(e){ res.status(500).json({error:e.message}); }
});
router.get('/invoices/:id', (req,res)=>{
  try{
    const inv = db.prepare('SELECT * FROM inv_invoices WHERE id=?').get(+req.params.id);
    if(!inv) return res.status(404).json({error:'Not found'});
    inv.items = db.prepare(`SELECT ii.*, i.code, i.name, i.unit FROM inv_invoice_items ii JOIN inv_items i ON i.id=ii.item_id WHERE ii.invoice_id=? ORDER BY ii.id`).all(inv.id);
    res.json(inv);
  }catch(e){ res.status(500).json({error:e.message}); }
});
// Invoice with lines; items may be existing {item_id} or new {new_item:{...}}
router.post('/invoices', requireAdmin, (req,res)=>{
  try{
    const { invoice_no, supplier, date, goods_currency, goods_to_jod_rate, extra_costs_jod, extra_costs_note, notes, items } = req.body;
    if(!Array.isArray(items) || !items.length) return res.status(400).json({error:'items required'});
    const rate = +goods_to_jod_rate || 1;
    const extra = +extra_costs_jod || 0;
    const tx = db.transaction(()=>{
      const inv = db.prepare(`INSERT INTO inv_invoices (invoice_no,supplier,date,goods_currency,goods_to_jod_rate,extra_costs_jod,extra_costs_note,notes,created_by)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(invoice_no||null, supplier||null, date||new Date().toISOString().slice(0,10),
        goods_currency||'JOD', rate, extra, extra_costs_note||null, notes||null, req.user.name);
      const invId = inv.lastInsertRowid;
      let totalGoodsJod = 0;
      const lines = items.map(l=>{
        let itemId = l.item_id;
        if(!itemId && l.new_item){
          const ni = l.new_item;
          const code = ni.code || genCode();
          const r = db.prepare(`INSERT INTO inv_items (code,name,name_ar,category,spec,unit,criticality,lead_time_days,min_stock,reorder_level,location,notes,created_by)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(code, ni.name, ni.name_ar||null, ni.category||'spare_part',
            ni.spec||null, ni.unit||'pc', ni.criticality||'normal', ni.lead_time_days||null,
            ni.min_stock??null, ni.reorder_level??null, ni.location||null, ni.notes||null, req.user.name);
          itemId = r.lastInsertRowid;
          (ni.machine_ids||[]).forEach(mid=>{ try{ db.prepare('INSERT INTO inv_item_machines (item_id,machine_id,station) VALUES (?,?,?)').run(itemId, +mid, ni.station||null); }catch(e){} });
        }
        if(!itemId) throw new Error('line missing item_id or new_item');
        const goodsJod = (+l.qty) * (+l.unit_price) * rate;
        totalGoodsJod += goodsJod;
        return { itemId, qty:+l.qty, unit_price:+l.unit_price, goodsJod };
      });
      const totalLanded = totalGoodsJod + extra;
      lines.forEach(l=>{
        const share = totalGoodsJod>0 ? l.goodsJod/totalGoodsJod : 1/lines.length;
        const lineLanded = l.goodsJod + extra*share;
        const landedUnit = l.qty>0 ? lineLanded/l.qty : 0;
        db.prepare(`INSERT INTO inv_invoice_items (invoice_id,item_id,qty,unit_price,line_goods,landed_unit_jod,line_landed_jod)
          VALUES (?,?,?,?,?,?,?)`).run(invId, l.itemId, l.qty, l.unit_price, +l.goodsJod.toFixed(4), +landedUnit.toFixed(4), +lineLanded.toFixed(4));
        applyWac(l.itemId, l.qty, landedUnit);
        addMovement({ item_id:l.itemId, kind:'in', qty:l.qty, unit_cost_jod:+landedUnit.toFixed(4),
          ref_type:'invoice', ref_id:invId, note:'Invoice '+(invoice_no||invId), date, created_by:req.user.name });
      });
      db.prepare('UPDATE inv_invoices SET total_goods_jod=?, total_landed_jod=? WHERE id=?')
        .run(+totalGoodsJod.toFixed(4), +totalLanded.toFixed(4), invId);
      return invId;
    });
    const id = tx();
    res.status(201).json(db.prepare('SELECT * FROM inv_invoices WHERE id=?').get(id));
  }catch(e){ res.status(500).json({error:e.message}); }
});

// -- items CRUD --------------------------------------------------------------
router.get('/items', (req,res)=>{
  try{
    const rows = db.prepare(`SELECT i.*, ${STOCK_SQL} AS stock FROM inv_items i ORDER BY i.code`).all();
    const links = db.prepare(`SELECT im.item_id, im.machine_id, im.station, m.code AS machine_code, m.name AS machine_name
      FROM inv_item_machines im JOIN machines m ON m.id=im.machine_id`).all();
    const lm = {};
    links.forEach(l=>{ (lm[l.item_id]=lm[l.item_id]||[]).push(l); });
    rows.forEach(r=>{ r.machines = lm[r.id]||[]; });
    res.json(rows);
  }catch(e){ res.status(500).json({error:e.message}); }
});
router.post('/items', requireAdmin, (req,res)=>{
  try{
    const b=req.body||{};
    if(!b.name) return res.status(400).json({error:'name required'});
    const code = b.code || genCode();
    const r = db.prepare(`INSERT INTO inv_items (code,name,name_ar,category,spec,unit,criticality,lead_time_days,min_stock,reorder_level,location,notes,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(code, b.name, b.name_ar||null, b.category||'spare_part',
      b.spec||null, b.unit||'pc', b.criticality||'normal', b.lead_time_days||null,
      b.min_stock??null, b.reorder_level??null, b.location||null, b.notes||null, req.user.name);
    (b.machine_links||[]).forEach(x=>{ try{ db.prepare('INSERT INTO inv_item_machines (item_id,machine_id,station) VALUES (?,?,?)').run(r.lastInsertRowid, +x.machine_id, x.station||null); }catch(e){} });
    res.status(201).json(db.prepare('SELECT * FROM inv_items WHERE id=?').get(r.lastInsertRowid));
  }catch(e){ res.status(500).json({error:e.message}); }
});
router.get('/items/:id', (req,res)=>{
  try{
    const i = db.prepare('SELECT * FROM inv_items WHERE id=?').get(+req.params.id);
    if(!i) return res.status(404).json({error:'Not found'});
    i.stock = stockOf(i.id);
    i.machines = db.prepare(`SELECT im.machine_id, im.station, m.code, m.name FROM inv_item_machines im JOIN machines m ON m.id=im.machine_id WHERE im.item_id=?`).all(i.id);
    i.recent = db.prepare('SELECT * FROM inv_movements WHERE item_id=? ORDER BY id DESC LIMIT 20').all(i.id);
    res.json(i);
  }catch(e){ res.status(500).json({error:e.message}); }
});
router.put('/items/:id', requireAdmin, (req,res)=>{
  try{
    const b=req.body||{}; const it=db.prepare('SELECT * FROM inv_items WHERE id=?').get(+req.params.id);
    if(!it) return res.status(404).json({error:'Not found'});
    const f=['code','name','name_ar','category','spec','unit','criticality','lead_time_days','min_stock','reorder_level','location','notes','active'];
    db.prepare(`UPDATE inv_items SET ${f.map(k=>k+'=?').join(',')} WHERE id=?`)
      .run(...f.map(k=>b[k]!==undefined?b[k]:it[k]), it.id);
    if(Array.isArray(b.machine_links)){
      db.prepare('DELETE FROM inv_item_machines WHERE item_id=?').run(it.id);
      b.machine_links.forEach(x=>{ try{ db.prepare('INSERT INTO inv_item_machines (item_id,machine_id,station) VALUES (?,?,?)').run(it.id, +x.machine_id, x.station||null); }catch(e){} });
    }
    res.json(db.prepare('SELECT * FROM inv_items WHERE id=?').get(it.id));
  }catch(e){ res.status(500).json({error:e.message}); }
});
router.delete('/items/:id', requireAdmin, (req,res)=>{
  try{
    const mv = db.prepare('SELECT COUNT(*) c FROM inv_movements WHERE item_id=?').get(+req.params.id).c;
    if(mv) return res.status(400).json({error:'Item has '+mv+' movement(s) - deactivate instead'});
    db.prepare('DELETE FROM inv_item_machines WHERE item_id=?').run(+req.params.id);
    db.prepare('DELETE FROM inv_items WHERE id=?').run(+req.params.id);
    res.json({ok:true});
  }catch(e){ res.status(500).json({error:e.message}); }
});

module.exports = router;
