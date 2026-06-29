// routes/pricing_admin.js
// BLOCK F-1 - CRUD admin for the modular pricing model (profiles, rules,
// extra-charge categories, product default attachments). Reads/writes ONLY the
// Block E-1 tables; does not touch orders or live billing.
const router = require('express').Router();
const db     = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
router.use(requireAuth);

const BASES   = ['per_sqm','per_linear_meter'];
const LENBAS  = ['perimeter','edges'];
const CONDS   = ['area_gt','side_gt','holes_gt','cutouts_gt','thickness_gt','qty_gt'];
const ACTS    = ['pct_uplift','flat_add','per_unit_add','set_min'];
const num = v => (v==null||v==='') ? null : Number(v);

// -- vocabulary for UI dropdowns --
router.get('/meta', (req,res) => res.json({
  bases: BASES, length_bases: LENBAS, condition_types: CONDS, action_types: ACTS,
  condition_help: { area_gt:'piece area (m2)', side_gt:'longest side (mm)', holes_gt:'drill holes',
                    cutouts_gt:'cutouts', thickness_gt:'thickness (mm)', qty_gt:'piece qty' },
  action_help: { pct_uplift:'add % of base', flat_add:'add fixed JD', per_unit_add:'add JD per unit beyond threshold', set_min:'raise base to at least' }
}));

// -- PROFILES --
router.get('/profiles', (req,res) => {
  try {
    const rows = db.prepare(`SELECT p.*, (SELECT COUNT(*) FROM pricing_rules r WHERE r.profile_id=p.id) rule_count,
                                    (SELECT COUNT(*) FROM product_default_price d WHERE d.profile_id=p.id) default_count
                             FROM price_profiles p WHERE p.customer_id IS NULL ORDER BY p.id`).all();
    res.json(rows);
  } catch(e){ res.status(500).json({error:e.message}); }
});
router.get('/profiles/:id', (req,res) => {
  try {
    const p = db.prepare('SELECT * FROM price_profiles WHERE id=?').get(+req.params.id);
    if(!p) return res.status(404).json({error:'Not found'});
    p.rules = db.prepare('SELECT * FROM pricing_rules WHERE profile_id=? ORDER BY priority,id').all(p.id);
    res.json(p);
  } catch(e){ res.status(500).json({error:e.message}); }
});
router.post('/profiles', requireAdmin, (req,res) => {
  try {
    const b = req.body||{};
    if(!b.name) return res.status(400).json({error:'name required'});
    const basis = BASES.includes(b.basis)? b.basis : 'per_sqm';
    const lb = LENBAS.includes(b.length_basis)? b.length_basis : 'perimeter';
    const info = db.prepare('INSERT INTO price_profiles(name,basis,length_basis,base_rate,min_per_piece,notes) VALUES(?,?,?,?,?,?)')
      .run(b.name, basis, lb, num(b.base_rate)||0, num(b.min_per_piece)||0, b.notes||null);
    res.json(db.prepare('SELECT * FROM price_profiles WHERE id=?').get(info.lastInsertRowid));
  } catch(e){ res.status(500).json({error:e.message}); }
});
router.put('/profiles/:id', requireAdmin, (req,res) => {
  try {
    const id=+req.params.id; const cur=db.prepare('SELECT * FROM price_profiles WHERE id=?').get(id);
    if(!cur) return res.status(404).json({error:'Not found'});
    const b=req.body||{};
    const basis = (b.basis!=null && BASES.includes(b.basis))? b.basis : cur.basis;
    const lb = (b.length_basis!=null && LENBAS.includes(b.length_basis))? b.length_basis : cur.length_basis;
    db.prepare('UPDATE price_profiles SET name=?,basis=?,length_basis=?,base_rate=?,min_per_piece=?,active=?,notes=? WHERE id=?')
      .run(b.name!=null?b.name:cur.name, basis, lb,
           b.base_rate!=null?num(b.base_rate):cur.base_rate,
           b.min_per_piece!=null?num(b.min_per_piece):cur.min_per_piece,
           b.active!=null?(b.active?1:0):cur.active, b.notes!=null?b.notes:cur.notes, id);
    res.json(db.prepare('SELECT * FROM price_profiles WHERE id=?').get(id));
  } catch(e){ res.status(500).json({error:e.message}); }
});
router.delete('/profiles/:id', requireAdmin, (req,res) => {
  try {
    const id=+req.params.id;
    const defs = db.prepare('SELECT COUNT(*) c FROM product_default_price WHERE profile_id=?').get(id).c;
    if(defs>0 && !req.query.force) return res.status(409).json({error:'Profile is a default on '+defs+' product(s). Pass ?force=1 to delete and clear those defaults.'});
    const tx = db.transaction(()=>{
      db.prepare('DELETE FROM product_default_price WHERE profile_id=?').run(id);
      db.prepare('DELETE FROM pricing_rules WHERE profile_id=?').run(id);
      db.prepare('DELETE FROM price_profiles WHERE id=?').run(id);
    }); tx();
    res.json({deleted:id});
  } catch(e){ res.status(500).json({error:e.message}); }
});

// -- RULES --
router.post('/profiles/:id/rules', requireAdmin, (req,res) => {
  try {
    const pid=+req.params.id; const b=req.body||{};
    if(!CONDS.includes(b.condition_type)) return res.status(400).json({error:'bad condition_type'});
    if(!ACTS.includes(b.action_type)) return res.status(400).json({error:'bad action_type'});
    const info=db.prepare('INSERT INTO pricing_rules(profile_id,condition_type,condition_value,action_type,action_value,priority,notes) VALUES(?,?,?,?,?,?,?)')
      .run(pid, b.condition_type, num(b.condition_value)||0, b.action_type, num(b.action_value)||0, num(b.priority)||0, b.notes||null);
    res.json(db.prepare('SELECT * FROM pricing_rules WHERE id=?').get(info.lastInsertRowid));
  } catch(e){ res.status(500).json({error:e.message}); }
});
router.put('/rules/:id', requireAdmin, (req,res) => {
  try {
    const id=+req.params.id; const cur=db.prepare('SELECT * FROM pricing_rules WHERE id=?').get(id);
    if(!cur) return res.status(404).json({error:'Not found'});
    const b=req.body||{};
    const ct=(b.condition_type!=null&&CONDS.includes(b.condition_type))?b.condition_type:cur.condition_type;
    const at=(b.action_type!=null&&ACTS.includes(b.action_type))?b.action_type:cur.action_type;
    db.prepare('UPDATE pricing_rules SET condition_type=?,condition_value=?,action_type=?,action_value=?,priority=?,active=?,notes=? WHERE id=?')
      .run(ct, b.condition_value!=null?num(b.condition_value):cur.condition_value, at,
           b.action_value!=null?num(b.action_value):cur.action_value,
           b.priority!=null?num(b.priority):cur.priority,
           b.active!=null?(b.active?1:0):cur.active, b.notes!=null?b.notes:cur.notes, id);
    res.json(db.prepare('SELECT * FROM pricing_rules WHERE id=?').get(id));
  } catch(e){ res.status(500).json({error:e.message}); }
});
router.delete('/rules/:id', requireAdmin, (req,res) => {
  try { db.prepare('DELETE FROM pricing_rules WHERE id=?').run(+req.params.id); res.json({deleted:+req.params.id}); }
  catch(e){ res.status(500).json({error:e.message}); }
});

// -- EXTRA-CHARGE CATEGORIES --
router.get('/categories', (req,res) => {
  try { res.json(db.prepare('SELECT * FROM extra_charge_categories ORDER BY sort_order,id').all()); }
  catch(e){ res.status(500).json({error:e.message}); }
});
router.post('/categories', requireAdmin, (req,res) => {
  try { const b=req.body||{}; if(!b.label) return res.status(400).json({error:'label required'});
    const info=db.prepare('INSERT INTO extra_charge_categories(code,label,description,sort_order) VALUES(?,?,?,?)')
      .run(b.code||null, b.label, b.description||null, num(b.sort_order)||0);
    res.json(db.prepare('SELECT * FROM extra_charge_categories WHERE id=?').get(info.lastInsertRowid));
  } catch(e){ res.status(500).json({error:e.message}); }
});
router.put('/categories/:id', requireAdmin, (req,res) => {
  try { const id=+req.params.id; const cur=db.prepare('SELECT * FROM extra_charge_categories WHERE id=?').get(id);
    if(!cur) return res.status(404).json({error:'Not found'});
    const b=req.body||{};
    db.prepare('UPDATE extra_charge_categories SET code=?,label=?,description=?,active=?,sort_order=? WHERE id=?')
      .run(b.code!=null?b.code:cur.code, b.label!=null?b.label:cur.label, b.description!=null?b.description:cur.description,
           b.active!=null?(b.active?1:0):cur.active, b.sort_order!=null?num(b.sort_order):cur.sort_order, id);
    res.json(db.prepare('SELECT * FROM extra_charge_categories WHERE id=?').get(id));
  } catch(e){ res.status(500).json({error:e.message}); }
});
router.delete('/categories/:id', requireAdmin, (req,res) => {
  try { db.prepare('DELETE FROM extra_charge_categories WHERE id=?').run(+req.params.id); res.json({deleted:+req.params.id}); }
  catch(e){ res.status(500).json({error:e.message}); }
});

// -- PRODUCTS + DEFAULT PROFILE ATTACHMENT --
router.get('/products', (req,res) => {
  try {
    const rows = db.prepare(`SELECT pr.id product_id, pr.legacy_fp_id, pr.label,
        d.profile_id default_profile_id, pp.name default_profile_name
        FROM products pr
        LEFT JOIN product_default_price d ON d.product_id=pr.id
        LEFT JOIN price_profiles pp ON pp.id=d.profile_id
        ORDER BY pr.id`).all();
    res.json(rows);
  } catch(e){ res.status(500).json({error:e.message}); }
});
router.put('/products/:id/default', requireAdmin, (req,res) => {
  try {
    const pid=+req.params.id; const profileId=num((req.body||{}).profile_id);
    const prod=db.prepare('SELECT id FROM products WHERE id=?').get(pid);
    if(!prod) return res.status(404).json({error:'Product not found'});
    if(profileId==null){ db.prepare('DELETE FROM product_default_price WHERE product_id=?').run(pid); return res.json({product_id:pid, default_profile_id:null}); }
    const prof=db.prepare('SELECT id FROM price_profiles WHERE id=?').get(profileId);
    if(!prof) return res.status(400).json({error:'profile_id not found'});
    db.prepare('INSERT INTO product_default_price(product_id,profile_id,updated_at) VALUES(?,?,datetime(\'now\')) ON CONFLICT(product_id) DO UPDATE SET profile_id=excluded.profile_id, updated_at=datetime(\'now\')').run(pid, profileId);
    res.json({product_id:pid, default_profile_id:profileId});
  } catch(e){ res.status(500).json({error:e.message}); }
});

// -- CUSTOMER PRICE PROFILES (Block G-1) ----------------------------------------
// Per-customer FULL COPIES of a global profile (rate, min, AND rules), editable
// independently. Mapped to (customer,product) via customer_price_profile so the
// pricing engine resolves them ahead of the product default. Editing a copy uses
// the same /profiles/:id and /rules endpoints above (they accept any profile id).

// list a customer's price entries (one per product), each = its owned profile copy
router.get('/customers/:cid/prices', (req,res) => {
  try {
    const cid=+req.params.cid;
    const rows = db.prepare(`SELECT cpp.product_id, pr.label product_label, pr.legacy_fp_id,
        pp.id profile_id, pp.name profile_name, pp.basis, pp.length_basis,
        pp.base_rate, pp.min_per_piece, pp.active, pp.source_profile_id,
        src.name source_name,
        (SELECT COUNT(*) FROM pricing_rules r WHERE r.profile_id=pp.id) rule_count
      FROM customer_price_profile cpp
      JOIN price_profiles pp ON pp.id=cpp.profile_id
      LEFT JOIN products pr ON pr.id=cpp.product_id
      LEFT JOIN price_profiles src ON src.id=pp.source_profile_id
      WHERE cpp.customer_id=? AND pp.customer_id=?
      ORDER BY pr.label, cpp.id`).all(cid, cid);
    res.json(rows);
  } catch(e){ res.status(500).json({error:e.message}); }
});

// add a global profile as a customer-owned copy for a product (clone incl. rules)
router.post('/customers/:cid/prices', requireAdmin, (req,res) => {
  try {
    const cid=+req.params.cid; const b=req.body||{};
    const productId=num(b.product_id), srcId=num(b.source_profile_id);
    if(productId==null) return res.status(400).json({error:'product_id required'});
    if(srcId==null)     return res.status(400).json({error:'source_profile_id required'});
    const prod=db.prepare('SELECT id FROM products WHERE id=?').get(productId);
    if(!prod) return res.status(400).json({error:'product not found'});
    const src=db.prepare('SELECT * FROM price_profiles WHERE id=? AND customer_id IS NULL').get(srcId);
    if(!src) return res.status(400).json({error:'source profile not found (must be a global profile)'});
    const tx = db.transaction(()=>{
      // if this customer already has an entry for this product, remove its old copy
      const ex=db.prepare('SELECT profile_id FROM customer_price_profile WHERE customer_id=? AND product_id=?').get(cid,productId);
      if(ex){
        db.prepare('DELETE FROM pricing_rules WHERE profile_id=?').run(ex.profile_id);
        db.prepare('DELETE FROM customer_price_profile WHERE customer_id=? AND product_id=?').run(cid,productId);
        db.prepare('DELETE FROM price_profiles WHERE id=? AND customer_id=?').run(ex.profile_id, cid);
      }
      const info=db.prepare(`INSERT INTO price_profiles(name,basis,length_basis,base_rate,min_per_piece,active,notes,customer_id,source_profile_id)
                             VALUES(?,?,?,?,?,?,?,?,?)`)
        .run(src.name, src.basis, src.length_basis, src.base_rate, src.min_per_piece, 1, src.notes, cid, srcId);
      const newId=info.lastInsertRowid;
      for(const r of db.prepare('SELECT * FROM pricing_rules WHERE profile_id=?').all(srcId)){
        db.prepare(`INSERT INTO pricing_rules(profile_id,condition_type,condition_value,action_type,action_value,priority,active,notes)
                    VALUES(?,?,?,?,?,?,?,?)`)
          .run(newId, r.condition_type, r.condition_value, r.action_type, r.action_value, r.priority, r.active, r.notes);
      }
      db.prepare('INSERT INTO customer_price_profile(customer_id,product_id,profile_id) VALUES(?,?,?)').run(cid,productId,newId);
      return newId;
    });
    const newId=tx();
    const row=db.prepare(`SELECT cpp.product_id, pr.label product_label, pr.legacy_fp_id,
        pp.id profile_id, pp.name profile_name, pp.basis, pp.length_basis,
        pp.base_rate, pp.min_per_piece, pp.active, pp.source_profile_id, src.name source_name,
        (SELECT COUNT(*) FROM pricing_rules r WHERE r.profile_id=pp.id) rule_count
      FROM customer_price_profile cpp JOIN price_profiles pp ON pp.id=cpp.profile_id
      LEFT JOIN products pr ON pr.id=cpp.product_id
      LEFT JOIN price_profiles src ON src.id=pp.source_profile_id
      WHERE cpp.customer_id=? AND cpp.profile_id=?`).get(cid,newId);
    res.json(row);
  } catch(e){ res.status(500).json({error:e.message}); }
});

// remove a customer's price entry for a product (drops the owned copy + its rules + the mapping)
router.delete('/customers/:cid/prices/:productId', requireAdmin, (req,res) => {
  try {
    const cid=+req.params.cid, productId=+req.params.productId;
    const map=db.prepare('SELECT profile_id FROM customer_price_profile WHERE customer_id=? AND product_id=?').get(cid,productId);
    if(!map) return res.status(404).json({error:'No price entry for this customer/product'});
    const tx=db.transaction(()=>{
      db.prepare('DELETE FROM pricing_rules WHERE profile_id=?').run(map.profile_id);
      db.prepare('DELETE FROM customer_price_profile WHERE customer_id=? AND product_id=?').run(cid,productId);
      db.prepare('DELETE FROM price_profiles WHERE id=? AND customer_id=?').run(map.profile_id, cid);
    }); tx();
    res.json({deleted:productId});
  } catch(e){ res.status(500).json({error:e.message}); }
});

module.exports = router;
