// routes/orders.js
const router = require('express').Router();
const db     = require('../db');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

// ── Schema migrations ──────────────────────────────────────────────────────
try { db.prepare(`ALTER TABLE orders ADD COLUMN order_type TEXT NOT NULL DEFAULT 'normal'`).run(); } catch(e){}
try { db.prepare(`ALTER TABLE orders ADD COLUMN original_order_id INTEGER`).run(); } catch(e){}
try { db.prepare(`ALTER TABLE orders ADD COLUMN type_reason_id INTEGER`).run(); } catch(e){}
try { db.prepare(`ALTER TABLE orders ADD COLUMN responsible_worker_id INTEGER`).run(); } catch(e){}
try { db.prepare(`ALTER TABLE orders ADD COLUMN remake_notes TEXT`).run(); } catch(e){}
try { db.prepare(`ALTER TABLE order_items ADD COLUMN original_piece_uid TEXT`).run(); } catch(e){}
try { db.prepare(`ALTER TABLE order_items ADD COLUMN drill_count INTEGER DEFAULT 0`).run(); } catch(e){}
try { db.prepare(`ALTER TABLE order_items ADD COLUMN cutout_count INTEGER DEFAULT 0`).run(); } catch(e){}
try { db.prepare(`ALTER TABLE orders ADD COLUMN external_process_id INTEGER`).run(); } catch(e){}

// ── Order Type Reasons table + seed ───────────────────────────────────────
try {
  db.prepare(`CREATE TABLE IF NOT EXISTS order_type_reasons (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    order_type TEXT NOT NULL,
    label      TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0,
    active     INTEGER DEFAULT 1
  )`).run();
  const count = db.prepare('SELECT COUNT(*) AS n FROM order_type_reasons').get().n;
  if (count === 0) {
    const seed = [
      ['remake_agi','Wrong dimensions cut',1],
      ['remake_agi','Glass breakage during production',2],
      ['remake_agi','Incorrect glass type used',3],
      ['remake_agi','Surface defect / scratch',4],
      ['remake_agi','Drilling error',5],
      ['remake_agi','Tempering defect',6],
      ['remake_agi','Edge work defect',7],
      ['remake_cust','Wrong dimensions submitted',1],
      ['remake_cust','Design change by customer',2],
      ['remake_cust','Damaged during customer handling',3],
      ['remake_cust','Wrong glass type ordered',4],
      ['remake_cust','Measurement error by customer',5],
      ['remake_cust','On-site fitting issue',6],
      ['sample','Showroom display',1],
      ['sample','Pre-sales prototype',2],
      ['sample','Customer approval sample',3],
      ['warranty','Spontaneous breakage (NiS)',1],
      ['warranty','Delamination',2],
      ['warranty','Seal failure (IGU)',3],
      ['warranty','Installation defect',4],
    ];
    const ins = db.prepare('INSERT INTO order_type_reasons (order_type,label,sort_order) VALUES (?,?,?)');
    seed.forEach(([t,l,s]) => ins.run(t,l,s));
  }
} catch(e) { console.error('[orders] type_reasons setup:', e.message); }

// ── Constants & validation ─────────────────────────────────────────────────
const ORDER_TYPES  = ['normal','remake_agi','remake_cust','sample','warranty'];
const REMAKE_TYPES = ['remake_agi','remake_cust'];

function validateOrderType(body) {
  const type = body.order_type || 'normal';
  if (!ORDER_TYPES.includes(type))             return 'Invalid order_type';
  const requiresReason = ['remake_agi','remake_cust','warranty'].includes(type);
  if (requiresReason && !body.type_reason_id) return 'Reason is required for this order type';
  if (REMAKE_TYPES.includes(type) && !body.original_order_id) return 'Original order is required for remake orders';
  if (type === 'remake_agi' && !body.responsible_worker_id)    return 'Responsible worker is required for AGI remakes';
  return null;
}

// ── GET /api/orders ────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  try {
    const { status, customerId, orderType } = req.query;
    let sql = `
      SELECT o.*,
        c.name AS customer_name, c.code AS customer_code, c.company AS customer_company,
        otr.label AS type_reason_label,
        oo.num  AS original_order_num,
        w.name  AS responsible_worker_name,
        (SELECT COUNT(*) FROM order_items WHERE order_id=o.id) AS line_items,
        (SELECT COALESCE(SUM(qty),0) FROM order_items WHERE order_id=o.id) AS total_pieces,
        (SELECT COALESCE(SUM(w*h*qty),0) FROM order_items WHERE order_id=o.id)/1000000.0 AS total_sqm
      FROM orders o
      JOIN customers c ON c.id=o.customer_id
      LEFT JOIN order_type_reasons otr ON otr.id=o.type_reason_id
      LEFT JOIN orders oo ON oo.id=o.original_order_id
      LEFT JOIN workers w  ON w.id=o.responsible_worker_id
      WHERE 1=1`;
    const params = [];
    if (status)     { sql += ' AND o.status=?';       params.push(status); }
    if (customerId) { sql += ' AND o.customer_id=?';  params.push(+customerId); }
    if (orderType)  { sql += ' AND o.order_type=?';   params.push(orderType); }
    sql += ' ORDER BY o.id DESC';
    const rows = db.prepare(sql).all(...params).map(r=>({
      ...r, customerId:r.customer_id, finalProductId:r.final_product_id,
      attachments:JSON.parse(r.attachments||'[]'), orderType:r.order_type||'normal'
    }));
    // Optional: include items in list for performance (avoids N+1 fetches)
    if (req.query.include_items === '1') {
      const allItems = db.prepare('SELECT * FROM order_items ORDER BY order_id, sort_order, id').all();
      const itemsMap = {};
      allItems.forEach(i => {
        if(!itemsMap[i.order_id]) itemsMap[i.order_id]=[];
        itemsMap[i.order_id].push({
          ...i,
          processes:  JSON.parse(i.processes||'[]'),
          pieceUIDs:  JSON.parse(i.piece_uids||'[]'),
          piece_uids: JSON.parse(i.piece_uids||'[]'),
          glassType:  i.glass_type,
          bevelMM:    i.bevel_mm,
          startSerial:i.start_serial,
          drillCount: i.drill_count||0,
          cutoutCount:i.cutout_count||0,
          originalPieceUid: i.original_piece_uid||null,
          attachments:[]
        });
      });
      rows.forEach(o => { o.items = itemsMap[o.id] || []; });
    }
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Cancel Reasons CRUD ────────────────────────────────────────────────────
try { db.prepare(`CREATE TABLE IF NOT EXISTS cancel_reasons (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL, created_at DATETIME DEFAULT (datetime('now','localtime')))`).run(); } catch(e){}
router.get('/cancel-reasons',    (req,res)=>{try{res.json(db.prepare('SELECT * FROM cancel_reasons ORDER BY label').all());}catch(e){res.status(500).json({error:e.message});}});
router.post('/cancel-reasons',   (req,res)=>{try{const{label}=req.body;if(!label)return res.status(400).json({error:'label required'});const r=db.prepare('INSERT INTO cancel_reasons (label) VALUES (?)').run(label.trim());res.status(201).json(db.prepare('SELECT * FROM cancel_reasons WHERE id=?').get(r.lastInsertRowid));}catch(e){res.status(500).json({error:e.message});}});
router.put('/cancel-reasons/:id',(req,res)=>{try{const{label}=req.body;if(!label)return res.status(400).json({error:'label required'});db.prepare('UPDATE cancel_reasons SET label=? WHERE id=?').run(label.trim(),+req.params.id);res.json(db.prepare('SELECT * FROM cancel_reasons WHERE id=?').get(+req.params.id));}catch(e){res.status(500).json({error:e.message});}});
router.delete('/cancel-reasons/:id',(req,res)=>{try{db.prepare('DELETE FROM cancel_reasons WHERE id=?').run(+req.params.id);res.json({ok:true});}catch(e){res.status(500).json({error:e.message});}});

// ── Order Type Reasons CRUD ────────────────────────────────────────────────
router.get('/type-reasons', (req,res)=>{
  try{
    const{order_type}=req.query;
    let sql='SELECT * FROM order_type_reasons WHERE active=1';
    const params=[];
    if(order_type){sql+=' AND order_type=?';params.push(order_type);}
    sql+=' ORDER BY order_type,sort_order,label';
    res.json(db.prepare(sql).all(...params));
  }catch(e){res.status(500).json({error:e.message});}
});
router.post('/type-reasons',(req,res)=>{
  try{
    const{order_type,label,sort_order}=req.body;
    if(!order_type||!label) return res.status(400).json({error:'order_type and label required'});
    if(!ORDER_TYPES.includes(order_type)||order_type==='normal') return res.status(400).json({error:'Invalid order_type'});
    const r=db.prepare('INSERT INTO order_type_reasons (order_type,label,sort_order) VALUES (?,?,?)').run(order_type,label.trim(),+sort_order||0);
    res.status(201).json(db.prepare('SELECT * FROM order_type_reasons WHERE id=?').get(r.lastInsertRowid));
  }catch(e){res.status(500).json({error:e.message});}
});
router.put('/type-reasons/:id',(req,res)=>{
  try{
    const{label,sort_order,active}=req.body;
    if(!label) return res.status(400).json({error:'label required'});
    db.prepare('UPDATE order_type_reasons SET label=?,sort_order=?,active=? WHERE id=?').run(label.trim(),+sort_order||0,active===false?0:1,+req.params.id);
    res.json(db.prepare('SELECT * FROM order_type_reasons WHERE id=?').get(+req.params.id));
  }catch(e){res.status(500).json({error:e.message});}
});
router.delete('/type-reasons/:id',(req,res)=>{
  try{db.prepare('DELETE FROM order_type_reasons WHERE id=?').run(+req.params.id);res.json({ok:true});}
  catch(e){res.status(500).json({error:e.message});}
});

// ── GET /api/orders/:id ────────────────────────────────────────────────────
router.get('/:id', (req, res) => {
  try {
    const order = db.prepare(`
      SELECT o.*, c.name AS customer_name, c.code AS customer_code, c.company AS customer_company,
        otr.label AS type_reason_label, oo.num AS original_order_num, w.name AS responsible_worker_name
      FROM orders o JOIN customers c ON c.id=o.customer_id
      LEFT JOIN order_type_reasons otr ON otr.id=o.type_reason_id
      LEFT JOIN orders oo ON oo.id=o.original_order_id
      LEFT JOIN workers w  ON w.id=o.responsible_worker_id
      WHERE o.id=?`).get(+req.params.id);
    if (!order) return res.status(404).json({ error: 'Not found' });
    const items = db.prepare('SELECT * FROM order_items WHERE order_id=? ORDER BY sort_order,id').all(+req.params.id);
    order.items = items.map(i => ({
      ...i,
      processes: JSON.parse(i.processes||'[]'),
      pieceUIDs: JSON.parse(i.piece_uids||'[]'),
      piece_uids:JSON.parse(i.piece_uids||'[]'),
      glassType: i.glass_type, bevelMM:i.bevel_mm, startSerial:i.start_serial,
      drillCount: i.drill_count||0, cutoutCount: i.cutout_count||0,
      originalPieceUid: i.original_piece_uid||null,
      attachments:[]
    }));
    order.attachments = JSON.parse(order.attachments||'[]');
    order.customerId  = order.customer_id;
    order.finalProductId = order.final_product_id;
    order.orderType   = order.order_type||'normal';
    res.json(order);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/orders ───────────────────────────────────────────────────────
router.post('/', (req, res) => {
  try {
    const { customerId, date, extref, notes, items, attachments, finalProductId,
            order_type, type_reason_id, original_order_id, responsible_worker_id, remake_notes,
            external_process_id } = req.body;
    if (!customerId || !date || !Array.isArray(items) || !items.length)
      return res.status(400).json({ error: 'customerId, date, items[] required' });
    const typeErr = validateOrderType(req.body);
    if (typeErr) return res.status(400).json({ error: typeErr });
    const customer = db.prepare('SELECT * FROM customers WHERE id=?').get(+customerId);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });
    // ── Auto-numbering by order type ──────────────────────────────────────
    const TYPE_SUFFIX = { remake_agi:'RA', remake_cust:'RC', sample:'SA', warranty:'WA' };
    const suffix = TYPE_SUFFIX[order_type] || null;
    let orderNum;

    if (REMAKE_TYPES.includes(order_type)) {
      const orig = db.prepare('SELECT id,num FROM orders WHERE id=?').get(+original_order_id);
      if (!orig) return res.status(400).json({ error: 'Original order not found' });
      const base = orig.num + '-' + suffix;
      if (!db.prepare('SELECT id FROM orders WHERE num=?').get(base)) {
        orderNum = base;
      } else {
        let n = 2;
        while (db.prepare('SELECT id FROM orders WHERE num=?').get(base + n)) n++;
        orderNum = base + n;
      }
    } else if (suffix) {
      const existing = db.prepare("SELECT num FROM orders WHERE customer_id=? AND order_type=?").all(+customerId, order_type);
      let maxN = 0;
      existing.forEach(r => { const n=parseInt(r.num.split('-').pop()); if(!isNaN(n)&&n>maxN) maxN=n; });
      let nextN = maxN + 1;
      orderNum = customer.code + '-' + suffix + '-' + nextN;
      while (db.prepare('SELECT id FROM orders WHERE num=?').get(orderNum)) { nextN++; orderNum = customer.code+'-'+suffix+'-'+nextN; }
    } else {
      const existing = db.prepare("SELECT num FROM orders WHERE customer_id=? AND (order_type='normal' OR order_type IS NULL)").all(+customerId);
      let maxN = 0;
      existing.forEach(r => { const n=parseInt(r.num.split('-').pop()); if(!isNaN(n)&&n>maxN) maxN=n; });
      let nextN = maxN + 1;
      orderNum = customer.code + '-' + nextN;
      while (db.prepare('SELECT id FROM orders WHERE num=?').get(orderNum)) { nextN++; orderNum=customer.code+'-'+nextN; }
    }

    const orderId = db.transaction(() => {
      const r = db.prepare(`
        INSERT INTO orders (num,customer_id,date,extref,notes,status,attachments,
          order_type,type_reason_id,original_order_id,responsible_worker_id,remake_notes)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(orderNum,+customerId,date,extref||null,notes||null,'pending',JSON.stringify(attachments||[]),
             order_type||'normal',
             type_reason_id?+type_reason_id:null,
             original_order_id?+original_order_id:null,
             responsible_worker_id?+responsible_worker_id:null,
             remake_notes||null);
      if(finalProductId) db.prepare('UPDATE orders SET final_product_id=? WHERE id=?').run(+finalProductId,r.lastInsertRowid);
      if(external_process_id!==undefined) db.prepare('UPDATE orders SET external_process_id=? WHERE id=?').run(external_process_id?+external_process_id:null,r.lastInsertRowid);
      const oid=r.lastInsertRowid;
      let gs=1;
      for(let i=0;i<items.length;i++){
        const it=items[i]; const qty=Math.max(1,+it.qty||1);
        const uids=[]; for(let q=0;q<qty;q++){uids.push(`${orderNum}-${gs}`);gs++;}
        db.prepare(`INSERT INTO order_items
          (order_id,code,w,h,thickness,glass_type,color,family,pattern,qty,processes,bevel_mm,drill_count,cutout_count,sort_order,piece_uids,start_serial,original_piece_uid)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          oid,(it.code||'').toUpperCase(),+it.w,+it.h,
          +it.thickness||6,it.glassType||it.glass_type||'glass',it.color||'clear',(it.family||'float'),(it.pattern||null),qty,
          JSON.stringify(it.processes||[]),+it.bevelMM||+it.bevel_mm||0,
          +it.drillCount||+it.drill_count||0,+it.cutoutCount||+it.cutout_count||0,i,
          JSON.stringify(uids),uids[0]?+uids[0].split('-').pop():gs-qty,
          it.originalPieceUid||it.original_piece_uid||null);
      }
      return oid;
    })();
    syncOrderLabels(orderId, orderNum, date);
    res.status(201).json(db.prepare(`SELECT o.*,c.name AS customer_name,c.code AS customer_code FROM orders o JOIN customers c ON c.id=o.customer_id WHERE o.id=?`).get(orderId));
  } catch (e) { console.error('[orders POST]',e); res.status(500).json({ error: e.message }); }
});

// ── PUT /api/orders/:id ────────────────────────────────────────────────────
router.put('/:id', (req, res) => {
  try {
    const { customerId, num, date, extref, notes, items, attachments, finalProductId,
            order_type, type_reason_id, original_order_id, responsible_worker_id, remake_notes,
            external_process_id } = req.body;
    if (!customerId || !date || !Array.isArray(items) || !items.length)
      return res.status(400).json({ error: 'customerId, date, items[] required' });
    const typeErr = validateOrderType(req.body);
    if (typeErr) return res.status(400).json({ error: typeErr });
    const customer = db.prepare('SELECT * FROM customers WHERE id=?').get(+customerId);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });
    const order = db.prepare('SELECT * FROM orders WHERE id=?').get(+req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    // Customer changed + no deliberate custom number -> regenerate in the NEW
    // customer's series (max serial + 1), preserving remake-suffix series.
    let effNum = num;
    if (+customerId !== order.customer_id && (!num || !num.trim() || num.trim() === order.num)) {
      const parts = order.num.split('-');
      const sfx = parts.length === 3 ? parts[1] : null;
      const rows = sfx
        ? db.prepare("SELECT num FROM orders WHERE customer_id=? AND order_type=?").all(+customerId, order.order_type || 'normal')
        : db.prepare("SELECT num FROM orders WHERE customer_id=? AND (order_type='normal' OR order_type IS NULL)").all(+customerId);
      let maxN = 0;
      rows.forEach(r => { const x = parseInt(r.num.split('-').pop()); if (!isNaN(x) && x > maxN) maxN = x; });
      let nextN = maxN + 1;
      let cand = sfx ? (customer.code + '-' + sfx + '-' + nextN) : (customer.code + '-' + nextN);
      while (db.prepare('SELECT id FROM orders WHERE num=?').get(cand)) { nextN++; cand = sfx ? (customer.code+'-'+sfx+'-'+nextN) : (customer.code+'-'+nextN); }
      effNum = cand;
    }
    const newNum = (effNum && effNum.trim() && effNum.trim() !== order.num) ? effNum.trim() : order.num;
    if (newNum !== order.num) {
      const conflict = db.prepare('SELECT id FROM orders WHERE num=? AND id!=?').get(newNum, +req.params.id);
      if (conflict) return res.status(409).json({ error: `Order number ${newNum} already exists` });
    }

    db.transaction(() => {
      db.prepare(`UPDATE orders SET num=?,customer_id=?,date=?,extref=?,notes=?,attachments=?,
        order_type=?,type_reason_id=?,original_order_id=?,responsible_worker_id=?,remake_notes=?,
        external_process_id=?,updated_at=datetime('now') WHERE id=?`).run(
        newNum,+customerId,date,extref||null,notes||null,JSON.stringify(attachments||[]),
        order_type||'normal',
        type_reason_id?+type_reason_id:null,
        original_order_id?+original_order_id:null,
        responsible_worker_id?+responsible_worker_id:null,
        remake_notes||null,
        external_process_id!==undefined?(external_process_id?+external_process_id:null):null,
        +req.params.id);
      if(finalProductId!==undefined)
        db.prepare('UPDATE orders SET final_product_id=? WHERE id=?').run(finalProductId?+finalProductId:null,+req.params.id);
      db.prepare('DELETE FROM order_items WHERE order_id=?').run(+req.params.id);
      let gs=1;
      for(let i=0;i<items.length;i++){
        const it=items[i]; const qty=Math.max(1,+it.qty||1);
        const uids=[]; for(let q=0;q<qty;q++){uids.push(`${newNum}-${gs}`);gs++;}
        db.prepare(`INSERT INTO order_items
          (order_id,code,w,h,thickness,glass_type,color,family,pattern,qty,processes,bevel_mm,drill_count,cutout_count,sort_order,piece_uids,start_serial,original_piece_uid)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          +req.params.id,(it.code||'').toUpperCase(),+it.w,+it.h,
          +it.thickness||6,it.glassType||it.glass_type||'glass',it.color||'clear',(it.family||'float'),(it.pattern||null),qty,
          JSON.stringify(it.processes||[]),+it.bevelMM||+it.bevel_mm||0,
          +it.drillCount||+it.drill_count||0,+it.cutoutCount||+it.cutout_count||0,i,
          JSON.stringify(uids),uids[0]?+uids[0].split('-').pop():gs-qty,
          it.originalPieceUid||it.original_piece_uid||null);
      }
    })();
    syncOrderLabels(+req.params.id, (db.prepare('SELECT num FROM orders WHERE id=?').get(+req.params.id)||{}).num||'', date);
    res.json(db.prepare(`SELECT o.*,c.name AS customer_name,c.code AS customer_code FROM orders o JOIN customers c ON c.id=o.customer_id WHERE o.id=?`).get(+req.params.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /api/orders/:id/status ───────────────────────────────────────────
router.patch('/:id/status', (req, res) => {
  try {
    const { status, cancel_reason, cancelled_by, completed_by } = req.body;
    const ALLOWED = ['pending','cutting','done','cancelled'];
    if (!ALLOWED.includes(status))
      return res.status(400).json({ error: 'Invalid status' });

    const id = +req.params.id;
    const order = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const cols = db.prepare('PRAGMA table_info(orders)').all().map(c => c.name);

    if (status === 'cancelled') {
      const sets = ['status = ?', "updated_at = datetime('now')"];
      const args = ['cancelled'];
      if (cols.includes('cancelled_at')) { sets.push("cancelled_at = datetime('now')"); }
      if (cols.includes('cancel_reason')) { sets.push('cancel_reason = ?'); args.push(cancel_reason || null); }
      if (cols.includes('cancelled_by'))  { sets.push('cancelled_by = ?');  args.push(cancelled_by || null); }
      args.push(id);
      db.prepare(`UPDATE orders SET ${sets.join(', ')} WHERE id = ?`).run(...args);
      return res.json({ ok: true, status: 'cancelled' });
    }

    if (status === 'done') {
      const sets = ['status = ?', "updated_at = datetime('now')"];
      const args = ['done'];
      if (cols.includes('completed_at')) { sets.push("completed_at = datetime('now')"); }
      if (cols.includes('completed_by'))  { sets.push('completed_by = ?');  args.push(completed_by || null); }
      args.push(id);
      db.prepare(`UPDATE orders SET ${sets.join(', ')} WHERE id = ?`).run(...args);
      return res.json({ ok: true, status: 'done' });
    }

    const sets = ['status = ?', "updated_at = datetime('now')"];
    const args = [status];
    if (cols.includes('cancelled_at') && order.cancelled_at) sets.push('cancelled_at = NULL');
    if (cols.includes('cancel_reason') && order.cancel_reason) sets.push('cancel_reason = NULL');
    if (cols.includes('cancelled_by')  && order.cancelled_by)  sets.push('cancelled_by = NULL');
    if (cols.includes('completed_at')  && order.completed_at)  sets.push('completed_at = NULL');
    if (cols.includes('completed_by')  && order.completed_by)  sets.push('completed_by = NULL');
    args.push(id);
    db.prepare(`UPDATE orders SET ${sets.join(', ')} WHERE id = ?`).run(...args);
    res.json({ ok: true, status });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/orders/:id ─────────────────────────────────────────────────
router.delete('/:id', (req, res) => {
  try {
    const id=+req.params.id;
    const optFiles=db.prepare("SELECT id,name,status,order_ids FROM opt_files WHERE status IN ('pending','done')").all();
    const blockedBy=optFiles.find(f=>{try{return JSON.parse(f.order_ids||'[]').map(Number).includes(id);}catch(e){return false;}});
    if(blockedBy) return res.status(409).json({error:'Cannot delete: order is included in optimization "'+blockedBy.name+'" (status: '+blockedBy.status+'). Remove it from the optimization first.'});
    db.prepare('DELETE FROM order_items WHERE order_id=?').run(id);
    try{db.prepare('DELETE FROM label_scan_log WHERE label_uid IN (SELECT uid FROM label_items WHERE order_id=?)').run(id);}catch(e){}
    try{db.prepare('DELETE FROM label_items WHERE order_id=?').run(id);}catch(e){}
    db.prepare('DELETE FROM orders WHERE id=?').run(id);
    res.json({ ok:true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Auto-sync label_items when order is saved ──────────────────────────────
function syncOrderLabels(orderId, orderNum, orderDate) {
  try {
    const items = db.prepare('SELECT * FROM order_items WHERE order_id=?').all(orderId);
    const upsert = db.prepare(`
      INSERT INTO label_items (uid,code,w,h,thickness,glass_type,color,family,pattern,processes,bevel_mm,drill_count,cutout_count,order_id,order_num,date)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(uid) DO UPDATE SET
        w=excluded.w, h=excluded.h, thickness=excluded.thickness,
        glass_type=excluded.glass_type, color=excluded.color,
        family=excluded.family, pattern=excluded.pattern,
        processes=excluded.processes, bevel_mm=excluded.bevel_mm,
        drill_count=excluded.drill_count, cutout_count=excluded.cutout_count,
        order_id=excluded.order_id, order_num=excluded.order_num
    `);
    const sync = db.transaction(() => {
      for (const item of items) {
        const uids = JSON.parse(item.piece_uids || '[]');
        for (const uid of uids) {
          upsert.run(
            uid, uid, +item.w||0, +item.h||0, +item.thickness||6,
            item.glass_type||'glass', item.color||'clear',
            item.family||'float', item.pattern||null,
            item.processes||'[]',
            +item.bevel_mm||0, +item.drill_count||0, +item.cutout_count||0,
            orderId, orderNum, orderDate
          );
        }
      }
    });
    sync();
  } catch(e) { console.warn('[syncOrderLabels]', e.message); }
}

module.exports = router;
