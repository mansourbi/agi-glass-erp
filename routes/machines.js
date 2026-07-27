// routes/machines.js - Machines registry, costs, workers, maintenance
const router = require('express').Router();
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
router.use(requireAuth);

// -- migrations --------------------------------------------------------------
try { db.prepare(`CREATE TABLE IF NOT EXISTS machines (
  id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE, name TEXT NOT NULL, name_ar TEXT,
  model TEXT, serial_no TEXT, type TEXT, brand TEXT, origin TEXT, supplier TEXT,
  purchase_date TEXT, dims_l_mm INTEGER, dims_w_mm INTEGER, dims_h_mm INTEGER,
  weight_kg REAL, power_kw REAL, voltage TEXT, specs TEXT, status TEXT DEFAULT 'active',
  notes TEXT, photo TEXT, created_at DATETIME DEFAULT (datetime('now','localtime')))`).run(); } catch(e) {}
try { db.prepare(`CREATE TABLE IF NOT EXISTS machine_costs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, machine_id INTEGER NOT NULL, cost_type TEXT,
  description TEXT, amount REAL, currency TEXT DEFAULT 'JOD', exchange_rate_to_jod REAL DEFAULT 1,
  amount_jod REAL, date TEXT, notes TEXT, created_at DATETIME DEFAULT (datetime('now','localtime')))`).run(); } catch(e) {}
try { db.prepare(`CREATE TABLE IF NOT EXISTS machine_workers (
  id INTEGER PRIMARY KEY AUTOINCREMENT, machine_id INTEGER NOT NULL, worker_id INTEGER NOT NULL,
  worker_name TEXT, role TEXT DEFAULT 'responsible', from_date TEXT, to_date TEXT,
  assigned_by TEXT, created_at DATETIME DEFAULT (datetime('now','localtime')))`).run(); } catch(e) {}
try { db.prepare(`CREATE TABLE IF NOT EXISTS maintenance_checklists (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, name_ar TEXT, active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT (datetime('now','localtime')))`).run(); } catch(e) {}
try { db.prepare(`CREATE TABLE IF NOT EXISTS maintenance_checklist_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT, checklist_id INTEGER NOT NULL, item_text TEXT NOT NULL,
  sort INTEGER DEFAULT 0)`).run(); } catch(e) {}
try { db.prepare(`CREATE TABLE IF NOT EXISTS machine_maintenance_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT, machine_id INTEGER NOT NULL, checklist_id INTEGER,
  title TEXT, interval_days INTEGER, next_due TEXT, active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT (datetime('now','localtime')))`).run(); } catch(e) {}
try { db.prepare(`CREATE TABLE IF NOT EXISTS machine_maintenance_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, machine_id INTEGER NOT NULL, plan_id INTEGER,
  date TEXT, type TEXT DEFAULT 'scheduled', performed_by_id INTEGER, performed_by_name TEXT,
  duration_mins INTEGER, findings TEXT, status TEXT DEFAULT 'done',
  created_at DATETIME DEFAULT (datetime('now','localtime')))`).run(); } catch(e) {}
try { db.prepare(`CREATE TABLE IF NOT EXISTS maintenance_log_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT, log_id INTEGER NOT NULL, item_text TEXT,
  result TEXT DEFAULT 'ok', note TEXT)`).run(); } catch(e) {}

function genCode(){
  const r = db.prepare("SELECT code FROM machines WHERE code LIKE 'M-%'").all()
    .map(x=>+String(x.code).replace('M-',''))
    .filter(n=>!isNaN(n));
  const n = (r.length ? Math.max(...r) : 0) + 1;
  return 'M-' + String(n).padStart(2,'0');
}

// -- checklists (specific before :param) -------------------------------------
router.get('/checklists', (req,res)=>{
  try{
    const ls = db.prepare('SELECT * FROM maintenance_checklists ORDER BY name').all();
    ls.forEach(l=>{ l.items = db.prepare('SELECT * FROM maintenance_checklist_items WHERE checklist_id=? ORDER BY sort,id').all(l.id); });
    res.json(ls);
  }catch(e){ res.status(500).json({error:e.message}); }
});
router.post('/checklists', requireAdmin, (req,res)=>{
  try{
    const { name, name_ar, items } = req.body;
    if(!name) return res.status(400).json({error:'name required'});
    const r = db.prepare('INSERT INTO maintenance_checklists (name,name_ar) VALUES (?,?)').run(name, name_ar||null);
    (items||[]).forEach((t,i)=>db.prepare('INSERT INTO maintenance_checklist_items (checklist_id,item_text,sort) VALUES (?,?,?)').run(r.lastInsertRowid, String(t), i));
    res.status(201).json({id:r.lastInsertRowid});
  }catch(e){ res.status(500).json({error:e.message}); }
});
router.put('/checklists/:id', requireAdmin, (req,res)=>{
  try{
    const { name, name_ar, items, active } = req.body;
    db.prepare('UPDATE maintenance_checklists SET name=COALESCE(?,name), name_ar=COALESCE(?,name_ar), active=COALESCE(?,active) WHERE id=?')
      .run(name??null, name_ar??null, active??null, +req.params.id);
    if(Array.isArray(items)){
      db.prepare('DELETE FROM maintenance_checklist_items WHERE checklist_id=?').run(+req.params.id);
      items.forEach((t,i)=>db.prepare('INSERT INTO maintenance_checklist_items (checklist_id,item_text,sort) VALUES (?,?,?)').run(+req.params.id, String(t), i));
    }
    res.json({ok:true});
  }catch(e){ res.status(500).json({error:e.message}); }
});
router.delete('/checklists/:id', requireAdmin, (req,res)=>{
  try{
    const used = db.prepare('SELECT COUNT(*) c FROM machine_maintenance_plans WHERE checklist_id=?').get(+req.params.id).c;
    if(used) return res.status(400).json({error:'Checklist used by '+used+' plan(s)'});
    db.prepare('DELETE FROM maintenance_checklist_items WHERE checklist_id=?').run(+req.params.id);
    db.prepare('DELETE FROM maintenance_checklists WHERE id=?').run(+req.params.id);
    res.json({ok:true});
  }catch(e){ res.status(500).json({error:e.message}); }
});

// -- plans / logs / costs / workers (specific before :param) -----------------
router.put('/plans/:id', requireAdmin, (req,res)=>{
  try{
    const { title, checklist_id, interval_days, next_due, active } = req.body;
    db.prepare('UPDATE machine_maintenance_plans SET title=COALESCE(?,title), checklist_id=COALESCE(?,checklist_id), interval_days=COALESCE(?,interval_days), next_due=COALESCE(?,next_due), active=COALESCE(?,active) WHERE id=?')
      .run(title??null, checklist_id??null, interval_days??null, next_due??null, active??null, +req.params.id);
    res.json({ok:true});
  }catch(e){ res.status(500).json({error:e.message}); }
});
router.delete('/plans/:id', requireAdmin, (req,res)=>{
  try{ db.prepare('DELETE FROM machine_maintenance_plans WHERE id=?').run(+req.params.id); res.json({ok:true}); }
  catch(e){ res.status(500).json({error:e.message}); }
});
router.put('/costs/:id', requireAdmin, (req,res)=>{
  try{
    const { cost_type, description, amount, currency, exchange_rate_to_jod, date, notes } = req.body;
    const row = db.prepare('SELECT * FROM machine_costs WHERE id=?').get(+req.params.id);
    if(!row) return res.status(404).json({error:'Not found'});
    const amt  = amount!=null ? +amount : +row.amount;
    const rate = exchange_rate_to_jod!=null ? +exchange_rate_to_jod : +row.exchange_rate_to_jod;
    db.prepare(`UPDATE machine_costs SET cost_type=?, description=?, amount=?, currency=?,
      exchange_rate_to_jod=?, amount_jod=?, date=?, notes=? WHERE id=?`)
      .run(cost_type??row.cost_type, description??row.description, amt, currency??row.currency,
        rate, +(amt*rate).toFixed(4), date??row.date, notes??row.notes, +req.params.id);
    res.json({ok:true});
  }catch(e){ res.status(500).json({error:e.message}); }
});
router.delete('/costs/:id', requireAdmin, (req,res)=>{
  try{ db.prepare('DELETE FROM machine_costs WHERE id=?').run(+req.params.id); res.json({ok:true}); }
  catch(e){ res.status(500).json({error:e.message}); }
});

// -- machines CRUD -----------------------------------------------------------
router.get('/', (req,res)=>{
  try{
    const ms = db.prepare('SELECT * FROM machines ORDER BY code').all();
    ms.forEach(m=>{
      m.responsible = db.prepare("SELECT worker_id, worker_name, role, from_date FROM machine_workers WHERE machine_id=? AND to_date IS NULL ORDER BY id DESC").all(m.id);
      m.total_cost_jod = db.prepare('SELECT COALESCE(SUM(amount_jod),0) t FROM machine_costs WHERE machine_id=?').get(m.id).t;
      m.plans_due = db.prepare("SELECT COUNT(*) c FROM machine_maintenance_plans WHERE machine_id=? AND active=1 AND next_due<=date('now','localtime')").get(m.id).c;
    });
    res.json(ms);
  }catch(e){ res.status(500).json({error:e.message}); }
});
router.post('/', requireAdmin, (req,res)=>{
  try{
    const b = req.body||{};
    if(!b.name) return res.status(400).json({error:'name required'});
    const code = b.code || genCode();
    const r = db.prepare(`INSERT INTO machines (code,name,name_ar,model,serial_no,type,brand,origin,supplier,purchase_date,
      dims_l_mm,dims_w_mm,dims_h_mm,weight_kg,power_kw,voltage,specs,status,notes)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      code, b.name, b.name_ar||null, b.model||null, b.serial_no||null, b.type||null, b.brand||null,
      b.origin||null, b.supplier||null, b.purchase_date||null, b.dims_l_mm||null, b.dims_w_mm||null,
      b.dims_h_mm||null, b.weight_kg||null, b.power_kw||null, b.voltage||null, b.specs||null,
      b.status||'active', b.notes||null);
    res.status(201).json(db.prepare('SELECT * FROM machines WHERE id=?').get(r.lastInsertRowid));
  }catch(e){ res.status(500).json({error:e.message}); }
});
router.get('/:id', (req,res)=>{
  try{
    const m = db.prepare('SELECT * FROM machines WHERE id=?').get(+req.params.id);
    if(!m) return res.status(404).json({error:'Not found'});
    m.costs = db.prepare('SELECT * FROM machine_costs WHERE machine_id=? ORDER BY date,id').all(m.id);
    m.total_cost_jod = m.costs.reduce((a,c)=>a+(+c.amount_jod||0),0);
    m.workers = db.prepare('SELECT * FROM machine_workers WHERE machine_id=? ORDER BY from_date DESC, id DESC').all(m.id);
    m.plans = db.prepare('SELECT p.*, c.name AS checklist_name FROM machine_maintenance_plans p LEFT JOIN maintenance_checklists c ON c.id=p.checklist_id WHERE p.machine_id=? ORDER BY p.next_due').all(m.id);
    m.logs = db.prepare('SELECT * FROM machine_maintenance_logs WHERE machine_id=? ORDER BY date DESC, id DESC LIMIT 50').all(m.id);
    m.items = db.prepare(`SELECT i.id, i.code, i.name, i.category, i.spec, i.unit, i.min_stock, im.station,
      COALESCE((SELECT SUM(CASE WHEN kind IN ('in','custody_return') THEN qty WHEN kind='adjust' THEN qty ELSE -qty END) FROM inv_movements WHERE item_id=i.id),0) AS stock
      FROM inv_item_machines im JOIN inv_items i ON i.id=im.item_id WHERE im.machine_id=? AND i.active=1 ORDER BY i.code`).all(m.id);
    res.json(m);
  }catch(e){ res.status(500).json({error:e.message}); }
});
router.put('/:id', requireAdmin, (req,res)=>{
  try{
    const b=req.body||{}; const m=db.prepare('SELECT * FROM machines WHERE id=?').get(+req.params.id);
    if(!m) return res.status(404).json({error:'Not found'});
    const f=['code','name','name_ar','model','serial_no','type','brand','origin','supplier','purchase_date','dims_l_mm','dims_w_mm','dims_h_mm','weight_kg','power_kw','voltage','specs','status','notes'];
    const sets=f.map(k=>`${k}=?`).join(',');
    db.prepare(`UPDATE machines SET ${sets} WHERE id=?`).run(...f.map(k=>b[k]!==undefined?b[k]:m[k]), m.id);
    res.json(db.prepare('SELECT * FROM machines WHERE id=?').get(m.id));
  }catch(e){ res.status(500).json({error:e.message}); }
});
router.post('/:id/costs', requireAdmin, (req,res)=>{
  try{
    const { cost_type, description, amount, currency, exchange_rate_to_jod, date, notes } = req.body;
    if(amount==null) return res.status(400).json({error:'amount required'});
    const rate = +exchange_rate_to_jod || 1;
    const r = db.prepare(`INSERT INTO machine_costs (machine_id,cost_type,description,amount,currency,exchange_rate_to_jod,amount_jod,date,notes)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(+req.params.id, cost_type||'other', description||null, +amount, currency||'JOD', rate, +amount*rate, date||null, notes||null);
    res.status(201).json({id:r.lastInsertRowid});
  }catch(e){ res.status(500).json({error:e.message}); }
});
router.post('/:id/workers', requireAdmin, (req,res)=>{
  try{
    const { worker_id, role, from_date } = req.body;
    if(!worker_id) return res.status(400).json({error:'worker_id required'});
    const w = db.prepare('SELECT name FROM workers WHERE id=?').get(+worker_id);
    const rl = role||'responsible';
    const fd = from_date || new Date().toISOString().slice(0,10);
    db.prepare("UPDATE machine_workers SET to_date=? WHERE machine_id=? AND role=? AND to_date IS NULL").run(fd, +req.params.id, rl);
    const r = db.prepare('INSERT INTO machine_workers (machine_id,worker_id,worker_name,role,from_date,assigned_by) VALUES (?,?,?,?,?,?)')
      .run(+req.params.id, +worker_id, w?.name||'', rl, fd, req.user.name);
    res.status(201).json({id:r.lastInsertRowid});
  }catch(e){ res.status(500).json({error:e.message}); }
});
router.post('/:id/plans', requireAdmin, (req,res)=>{
  try{
    const { title, checklist_id, interval_days, next_due } = req.body;
    const r = db.prepare('INSERT INTO machine_maintenance_plans (machine_id,checklist_id,title,interval_days,next_due) VALUES (?,?,?,?,?)')
      .run(+req.params.id, checklist_id||null, title||null, +interval_days||30, next_due||null);
    res.status(201).json({id:r.lastInsertRowid});
  }catch(e){ res.status(500).json({error:e.message}); }
});
router.post('/:id/logs', (req,res)=>{
  try{
    const { plan_id, date, type, duration_mins, findings, items } = req.body;
    const r = db.prepare(`INSERT INTO machine_maintenance_logs (machine_id,plan_id,date,type,performed_by_id,performed_by_name,duration_mins,findings)
      VALUES (?,?,?,?,?,?,?,?)`).run(+req.params.id, plan_id||null, date||new Date().toISOString().slice(0,10),
      type||'scheduled', req.user.id, req.user.name, +duration_mins||null, findings||null);
    (items||[]).forEach(it=>db.prepare('INSERT INTO maintenance_log_items (log_id,item_text,result,note) VALUES (?,?,?,?)')
      .run(r.lastInsertRowid, it.item_text||String(it), it.result||'ok', it.note||null));
    if(plan_id){
      const p = db.prepare('SELECT interval_days FROM machine_maintenance_plans WHERE id=?').get(+plan_id);
      if(p && p.interval_days){
        const d = new Date(date||Date.now()); d.setDate(d.getDate()+p.interval_days);
        db.prepare('UPDATE machine_maintenance_plans SET next_due=? WHERE id=?').run(d.toISOString().slice(0,10), +plan_id);
      }
    }
    res.status(201).json({id:r.lastInsertRowid});
  }catch(e){ res.status(500).json({error:e.message}); }
});
router.delete('/:id', requireAdmin, (req,res)=>{
  try{
    const logs = db.prepare('SELECT COUNT(*) c FROM machine_maintenance_logs WHERE machine_id=?').get(+req.params.id).c;
    const items = db.prepare('SELECT COUNT(*) c FROM inv_item_machines WHERE machine_id=?').get(+req.params.id).c;
    if(logs || items) return res.status(400).json({error:`Machine has ${logs} log(s) and ${items} linked item(s) - set status to retired instead`});
    ['machine_costs','machine_workers','machine_maintenance_plans'].forEach(t=>db.prepare(`DELETE FROM ${t} WHERE machine_id=?`).run(+req.params.id));
    db.prepare('DELETE FROM machines WHERE id=?').run(+req.params.id);
    res.json({ok:true});
  }catch(e){ res.status(500).json({error:e.message}); }
});

module.exports = router;
