// routes/pricing2.js
// BLOCK E-2 - modular pricing engine, PREVIEW MODE (read-only).
// Computes the new breakdown (profile resolve -> per-piece base+rules ->
// manual extras -> discount -> subtotal) WITHOUT writing anything and WITHOUT
// touching orderpricing.js / value_extras. Safe to run alongside live billing.
const router = require('express').Router();
const db     = require('../db');
const { requireAuth, requirePerm } = require('../middleware/auth');
router.use(requireAuth);
// Every route here reads or writes money. The portal hides the pricing tab for
// users without permission, but that is display only - enforce it server-side.
const canView = requirePerm('pricing.access');
const canEdit = requirePerm('pricing.edit');

// G-3: snapshot table for finalized order prices (created on load; no live migration)
db.exec("CREATE TABLE IF NOT EXISTS order_price_snapshot ("+
        "order_id INTEGER PRIMARY KEY, snapshot_json TEXT NOT NULL, subtotal REAL,"+
        "finalized_at TEXT NOT NULL, finalized_by TEXT)");

const round2 = n => Math.round((n + Number.EPSILON) * 100) / 100;

function computePiece(profile, piece, rules) {
  const w = +piece.w||0, h = +piece.h||0, qty = +piece.qty||1;
  const area  = (w*h)/1e6;          // sqm (single piece)
  const perim = (2*(w+h))/1000;     // linear meters (single piece, full perimeter)
  const minArea = +profile.min_billable_area || 0;                       // D4: area floor
  const billed  = Math.max(area, minArea);
  const min_hit = billed > area + 1e-9;
  let base = (profile.basis==='per_linear_meter') ? (profile.base_rate*perim) : (profile.base_rate*billed);
  if (profile.min_per_piece && base < profile.min_per_piece) base = profile.min_per_piece;
  const ovT=+profile.oversize_threshold_sqm||0, ovP=+profile.oversize_pct||0;   // D5
  const ov_hit = !!(ovT && ovP && area > ovT);
  const oversize = ov_hit ? base*(ovP/100) : 0;
  const weight_kg = area * (+piece.thickness||0) * 2.5;                  // D5 info
  const drivers = { area_gt:area, side_gt:Math.max(w,h), holes_gt:+piece.drill_count||0,
                    cutouts_gt:+piece.cutout_count||0, thickness_gt:+piece.thickness||0, qty_gt:qty };
  let extras = 0; const applied = [];
  const sorted = (rules||[]).filter(r=>r.active!==0).sort((a,b)=>(a.priority||0)-(b.priority||0));
  for (const r of sorted) {
    const drv = drivers[r.condition_type];
    if (drv==null || !(drv > r.condition_value)) continue;
    let add = 0;
    if (r.action_type==='pct_uplift')       add = base * (r.action_value/100);
    else if (r.action_type==='flat_add')    add = r.action_value;
    else if (r.action_type==='per_unit_add')add = (drv - r.condition_value) * r.action_value;
    else if (r.action_type==='set_min')     { if (base < r.action_value) base = r.action_value; }
    if (add) { extras += add; applied.push({ rule:r.condition_type+'>'+r.condition_value, action:r.action_type, amount:round2(add) }); }
  }
  return { id:piece.id, w, h, qty, area:round2(area), billed_area:round2(billed), min_hit, ov_hit,
           perim:round2(perim), weight_kg:round2(weight_kg*qty), base_unit:round2(base),
           oversize_unit:round2(oversize), extras_unit:round2(extras),
           line_base:round2(base*qty), line_oversize:round2(oversize*qty),
           line_extras:round2(extras*qty), applied, fees:[] };
}

function computeOrder(profile, pieces, rules, extraCharges, discount, opts) {
  opts = opts || {};
  const lines = pieces.map(p => computePiece(profile, p, rules));
  const value_base        = round2(lines.reduce((s,l)=>s+l.line_base,0));
  const value_oversize    = round2(lines.reduce((s,l)=>s+l.line_oversize,0));
  const value_rule_extras = round2(lines.reduce((s,l)=>s+l.line_extras,0));
  const pieceCount = lines.reduce((s,l)=>s+l.qty,0);
  const billedSum  = lines.reduce((s,l)=>s+l.billed_area*l.qty,0);
  // D6/D7: manual fees — basis-aware, order-level or piece-level
  let manual_extras = 0; const fee_lines = [];
  (extraCharges||[]).forEach(e=>{
    let amt;
    if (e.basis==='per_piece')     amt = (+e.rate||0) * (e.piece_uid ? (lines.find(l=>String(l.id)===String(e.piece_uid))||{qty:0}).qty : pieceCount);
    else if (e.basis==='per_sqm')  amt = (+e.rate||0) * (e.piece_uid ? (function(l){return l? l.billed_area*l.qty:0;})(lines.find(l=>String(l.id)===String(e.piece_uid))) : billedSum);
    else                           amt = +e.amount||0;
    amt = round2(amt); manual_extras += amt;
    const fl = { id:e.id, label:e.description||e.category_label||'', basis:e.basis||'total', rate:e.rate, amount:amt, piece_uid:e.piece_uid||null };
    fee_lines.push(fl);
    if (e.piece_uid){ const L=lines.find(l=>String(l.id)===String(e.piece_uid)); if(L) L.fees.push(fl); }
  });
  manual_extras = round2(manual_extras);
  const ext_sell = round2(+opts.ext_sell||0);                            // D8 via_agi line
  const pre = round2(value_base + value_oversize + value_rule_extras + manual_extras + ext_sell);
  let disc = 0;                                                          // D9 three modes
  if (discount && discount.type==='pct')          disc = pre * (discount.value/100);
  else if (discount && discount.type==='flat')    disc = discount.value||0;
  else if (discount && discount.type==='target_total') disc = pre - (discount.value||pre);
  disc = round2(Math.max(0, disc));
  const net = round2(pre - disc);
  const vat_pct = (opts.vat_pct==null) ? 16 : +opts.vat_pct;             // D10
  const vat = round2(net * vat_pct/100);
  const total_raw = round2(net + vat);
  const total = Math.round(total_raw);                                   // D13 nearest 1 JOD
  const rounding_adj = round2(total - total_raw);
  const weight_kg = round2(lines.reduce((s,l)=>s+l.weight_kg,0));
  return { value_base, value_oversize, value_rule_extras, manual_extras, ext_sell, fee_lines,
           pre_discount: pre, discount: disc, subtotal: net,
           vat_pct, vat, total_raw, total, rounding_adj, weight_kg,
           pieces_count: pieceCount, billed_sqm: round2(billedSum), lines };
}

// Resolve the active profile: order choice -> customer -> product default
function resolveProfile(order) {
  const oc = db.prepare('SELECT profile_id FROM order_price_choice WHERE order_id=? AND product_id IS NULL').get(order.id);
  if (oc && oc.profile_id) return { profile_id:oc.profile_id, source:'order' };
  let product = null;
  if (order.final_product_id) product = db.prepare('SELECT id FROM products WHERE legacy_fp_id=?').get(order.final_product_id);
  if (product) {
    if (order.customer_id) {
      const cp = db.prepare('SELECT profile_id FROM customer_price_profile WHERE customer_id=? AND product_id=?').get(order.customer_id, product.id);
      if (cp && cp.profile_id) return { profile_id:cp.profile_id, source:'customer', product_id:product.id };
    }
    const pd = db.prepare('SELECT profile_id FROM product_default_price WHERE product_id=?').get(product.id);
    if (pd && pd.profile_id) return { profile_id:pd.profile_id, source:'product_default', product_id:product.id };
  }
  // Fallback: products added after the June migration have no products row.
  // Allow a profile mapped straight onto final_products.
  if (order.final_product_id) {
    try {
      const fp = db.prepare('SELECT price_profile_id FROM final_products WHERE id=?').get(order.final_product_id);
      if (fp && fp.price_profile_id) return { profile_id:fp.price_profile_id, source:'product_default', product_id: product ? product.id : null };
    } catch(e) { /* column may not exist on older DBs */ }
  }
  return { profile_id:null, source:'none', product_id: product ? product.id : null };
}

// Build the full computed breakdown for an order (shared by preview + finalize)
function buildPreview(id, popts){
  popts = popts || {};
  const order = db.prepare('SELECT id, customer_id, final_product_id, customer_order_price FROM orders WHERE id=?').get(id);
  if (!order) return { error:'Order not found', status:404 };
  const resv = resolveProfile(order);
  // D12: an explicit per-order rate (o-cop) outranks every profile rate.
  const copRaw = (popts.rate_override!=null && popts.rate_override!=='') ? popts.rate_override : order.customer_order_price;
  const cop = (copRaw==null||copRaw==='') ? null : Number(copRaw);
  const hasCop = (cop!=null && isFinite(cop) && cop>0);
  if (!resv.profile_id && !hasCop)
    return { payload:{ order_id:id, resolved:resv, breakdown:null,
                       note:'No price profile resolved - set a product default, customer, or order profile.' } };
  let profile = resv.profile_id
    ? db.prepare('SELECT * FROM price_profiles WHERE id=?').get(resv.profile_id)
    : { id:null, name:'(order rate)', basis:'per_sqm', base_rate:cop, min_per_piece:null,
        min_billable_area:null, oversize_threshold_sqm:null, oversize_pct:null };
  if (hasCop) { profile = Object.assign({}, profile, { base_rate: cop });
                resv.source = 'order'; resv.override_rate = cop; }
  const rules   = db.prepare('SELECT * FROM pricing_rules WHERE profile_id=? AND active=1').all(resv.profile_id);
  const pieces  = db.prepare('SELECT id,w,h,qty,thickness,drill_count,cutout_count FROM order_items WHERE order_id=?').all(id);
  const extras  = db.prepare(`SELECT ec.id, ec.amount, ec.description, ec.category_id, ec.piece_uid, ec.basis, ec.rate, c.label category_label
                              FROM order_extra_charges ec LEFT JOIN extra_charge_categories c ON c.id=ec.category_id
                              WHERE ec.order_id=?`).all(id);
  const dc      = db.prepare('SELECT discount_type,discount_value,vat_pct,ext_settlement,ext_cost,ext_sell FROM order_price_choice WHERE order_id=? AND product_id IS NULL').get(id) || {};
  const discount = (dc && dc.discount_type) ? { type:dc.discount_type, value:dc.discount_value } : null;
  const opts = { vat_pct: dc.vat_pct, ext_sell: (dc.ext_settlement==='via_agi') ? (dc.ext_sell!=null?dc.ext_sell:dc.ext_cost) : 0 };
  const breakdown = computeOrder(profile, pieces, rules, extras, discount, opts);
  return { payload:{ order_id:id,
    resolved:{ ...resv, profile_name:profile.name, basis:profile.basis, base_rate:profile.base_rate, min_per_piece:profile.min_per_piece },
    pieces: pieces.length, breakdown } };
}

// GET /api/pricing2/:orderId/preview  - full computed breakdown (no writes)
router.get('/:orderId/preview', canView, (req, res) => {
  try {
    const r = buildPreview(+req.params.orderId);
    if (r.error) return res.status(r.status||500).json({ error:r.error });
    res.json(r.payload);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- BLOCK G-2b: order-level pricing writes (preview tables only; live billing untouched) ----
function _getOrder(id){ return db.prepare('SELECT id FROM orders WHERE id=?').get(id); }

// GET the raw order-level choice (profile override + discount)
router.get('/:orderId/choice', canView, (req,res) => {
  try {
    const id=+req.params.orderId;
    const row=db.prepare('SELECT profile_id, discount_type, discount_value, discount_note FROM order_price_choice WHERE order_id=? AND product_id IS NULL').get(id);
    res.json(row || { profile_id:null, discount_type:null, discount_value:null, discount_note:null });
  } catch(e){ res.status(500).json({error:e.message}); }
});

// PUT set/clear the order-level profile override + discount
router.put('/:orderId/choice', canEdit, (req,res) => {
  try {
    const id=+req.params.orderId;
    if(!_getOrder(id)) return res.status(404).json({error:'Order not found'});
    const b=req.body||{};
    const profile_id = (b.profile_id===''||b.profile_id==null) ? null : +b.profile_id;
    const dtype = (b.discount_type==='pct'||b.discount_type==='flat'||b.discount_type==='target_total') ? b.discount_type : null;
    const dval  = dtype ? (+b.discount_value||0) : null;
    const dnote = b.discount_note || null;
    const existing = db.prepare('SELECT id FROM order_price_choice WHERE order_id=? AND product_id IS NULL').get(id);
    if(profile_id==null && dtype==null && b.vat_pct==null && b.ext_settlement==null){
      if(existing) db.prepare('DELETE FROM order_price_choice WHERE id=?').run(existing.id);
      return res.json({ order_id:id, cleared:true });
    }
    const vat_pct = (b.vat_pct===''||b.vat_pct==null)?null:+b.vat_pct;
    const extS = (b.ext_settlement==='via_agi')?'via_agi':((b.ext_settlement==='customer_direct')?'customer_direct':null);
    const extC = (b.ext_cost===''||b.ext_cost==null)?null:+b.ext_cost;
    const extV = (b.ext_sell===''||b.ext_sell==null)?null:+b.ext_sell;
    if(existing){
      db.prepare('UPDATE order_price_choice SET profile_id=?, discount_type=?, discount_value=?, discount_note=?, vat_pct=?, ext_settlement=?, ext_cost=?, ext_sell=? WHERE id=?')
        .run(profile_id, dtype, dval, dnote, vat_pct, extS, extC, extV, existing.id);
    } else {
      db.prepare('INSERT INTO order_price_choice(order_id, product_id, profile_id, discount_type, discount_value, discount_note, vat_pct, ext_settlement, ext_cost, ext_sell) VALUES(?,NULL,?,?,?,?,?,?,?,?)')
        .run(id, profile_id, dtype, dval, dnote, vat_pct, extS, extC, extV);
    }
    res.json({ order_id:id, profile_id, discount_type:dtype, discount_value:dval, discount_note:dnote, vat_pct, ext_settlement:extS, ext_cost:extC, ext_sell:extV });
  } catch(e){ res.status(500).json({error:e.message}); }
});

// GET the order's manual extra charges
router.get('/:orderId/charges', canView, (req,res) => {
  try {
    const id=+req.params.orderId;
    const rows=db.prepare(`SELECT ec.id, ec.category_id, ec.description, ec.amount, ec.piece_uid, ec.basis, ec.rate, c.label category_label
                           FROM order_extra_charges ec LEFT JOIN extra_charge_categories c ON c.id=ec.category_id
                           WHERE ec.order_id=? ORDER BY ec.id`).all(id);
    res.json(rows);
  } catch(e){ res.status(500).json({error:e.message}); }
});

// POST add a manual extra charge
router.post('/:orderId/charges', canEdit, (req,res) => {
  try {
    const id=+req.params.orderId;
    if(!_getOrder(id)) return res.status(404).json({error:'Order not found'});
    const b=req.body||{};
    const basis=(b.basis==='per_piece'||b.basis==='per_sqm')?b.basis:'total';
    const rate=(basis!=='total')?+b.rate:null;
    const amount=(basis==='total')?+b.amount:null;
    if(basis==='total' && !(amount>0)) return res.status(400).json({error:'amount must be greater than 0'});
    if(basis!=='total' && !(rate>0))   return res.status(400).json({error:'rate must be greater than 0'});
    const cat=(b.category_id==null||b.category_id==='')?null:+b.category_id;
    const puid=(b.piece_uid==null||b.piece_uid==='')?null:String(b.piece_uid);
    const info=db.prepare("INSERT INTO order_extra_charges(order_id, category_id, description, amount, piece_uid, basis, rate, created_at) VALUES(?,?,?,?,?,?,?,datetime('now'))")
      .run(id, cat, b.description||null, amount!=null?round2(amount):null, puid, basis, rate);
    res.json(db.prepare('SELECT id, category_id, description, amount, piece_uid, basis, rate FROM order_extra_charges WHERE id=?').get(info.lastInsertRowid));
  } catch(e){ res.status(500).json({error:e.message}); }
});

// DELETE a manual extra charge (scoped to the order)
router.delete('/:orderId/charges/:chargeId', canEdit, (req,res) => {
  try {
    const id=+req.params.orderId, cid=+req.params.chargeId;
    db.prepare('DELETE FROM order_extra_charges WHERE id=? AND order_id=?').run(cid, id);
    res.json({deleted:cid});
  } catch(e){ res.status(500).json({error:e.message}); }
});

// ---- BLOCK G-3: finalize / un-finalize (snapshot-freeze the computed breakdown) ----
function _who(req){ return (req.user && (req.user.name||req.user.username||req.user.email))||null; }

// GET current snapshot (the frozen price), or finalized:false
router.get('/:orderId/snapshot', canView, (req,res) => {
  try {
    const id=+req.params.orderId;
    const row=db.prepare('SELECT order_id, snapshot_json, subtotal, finalized_at, finalized_by FROM order_price_snapshot WHERE order_id=?').get(id);
    if(!row) return res.json({ order_id:id, finalized:false });
    res.json({ order_id:id, finalized:true, finalized_at:row.finalized_at, finalized_by:row.finalized_by,
               subtotal:row.subtotal, snapshot:JSON.parse(row.snapshot_json) });
  } catch(e){ res.status(500).json({error:e.message}); }
});

// POST finalize: compute the current breakdown and freeze it (upsert)
router.post('/:orderId/finalize', canEdit, (req,res) => {
  try {
    const id=+req.params.orderId;
    const r=buildPreview(id);
    if(r.error) return res.status(r.status||500).json({error:r.error});
    const pv=r.payload;
    if(!pv.breakdown) return res.status(400).json({error:'Cannot finalize: no price profile resolved for this order.'});
    const at=new Date().toISOString(), who=_who(req), json=JSON.stringify(pv), sub=pv.breakdown.subtotal;
    const ex=db.prepare('SELECT order_id FROM order_price_snapshot WHERE order_id=?').get(id);
    if(ex) db.prepare('UPDATE order_price_snapshot SET snapshot_json=?, subtotal=?, finalized_at=?, finalized_by=? WHERE order_id=?').run(json,sub,at,who,id);
    else   db.prepare('INSERT INTO order_price_snapshot(order_id,snapshot_json,subtotal,finalized_at,finalized_by) VALUES(?,?,?,?,?)').run(id,json,sub,at,who);
    res.json({ order_id:id, finalized:true, finalized_at:at, finalized_by:who, subtotal:sub, snapshot:pv });
  } catch(e){ res.status(500).json({error:e.message}); }
});

// DELETE un-finalize: unlock to re-quote
router.delete('/:orderId/finalize', canEdit, (req,res) => {
  try {
    const id=+req.params.orderId;
    db.prepare('DELETE FROM order_price_snapshot WHERE order_id=?').run(id);
    res.json({ order_id:id, finalized:false });
  } catch(e){ res.status(500).json({error:e.message}); }
});

module.exports = router;
// Shared engine access for other routes (orderpricing write-back). Not an endpoint.
module.exports.engine = { buildPreview };

