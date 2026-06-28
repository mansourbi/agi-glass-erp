// routes/pricing2.js
// BLOCK E-2 - modular pricing engine, PREVIEW MODE (read-only).
// Computes the new breakdown (profile resolve -> per-piece base+rules ->
// manual extras -> discount -> subtotal) WITHOUT writing anything and WITHOUT
// touching orderpricing.js / value_extras. Safe to run alongside live billing.
const router = require('express').Router();
const db     = require('../db');
const { requireAuth } = require('../middleware/auth');
router.use(requireAuth);

const round2 = n => Math.round((n + Number.EPSILON) * 100) / 100;

function computePiece(profile, piece, rules) {
  const w = +piece.w||0, h = +piece.h||0, qty = +piece.qty||1;
  const area  = (w*h)/1e6;          // sqm (single piece)
  const perim = (2*(w+h))/1000;     // linear meters (single piece, full perimeter)
  let base = (profile.basis==='per_linear_meter') ? (profile.base_rate*perim) : (profile.base_rate*area);
  if (profile.min_per_piece && base < profile.min_per_piece) base = profile.min_per_piece;
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
  return { w, h, qty, area:round2(area), perim:round2(perim), base_unit:round2(base),
           extras_unit:round2(extras), line_base:round2(base*qty), line_extras:round2(extras*qty), applied };
}

function computeOrder(profile, pieces, rules, extraCharges, discount) {
  const lines = pieces.map(p => computePiece(profile, p, rules));
  const value_base        = round2(lines.reduce((s,l)=>s+l.line_base,0));
  const value_rule_extras = round2(lines.reduce((s,l)=>s+l.line_extras,0));
  const manual_extras     = round2((extraCharges||[]).reduce((s,e)=>s+(+e.amount||0),0));
  const pre = value_base + value_rule_extras + manual_extras;
  let disc = 0;
  if (discount && discount.type==='pct')  disc = pre * (discount.value/100);
  else if (discount && discount.type==='flat') disc = discount.value||0;
  disc = round2(disc);
  return { value_base, value_rule_extras, manual_extras, discount:disc, subtotal:round2(pre-disc), lines };
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
  return { profile_id:null, source:'none', product_id: product ? product.id : null };
}

// GET /api/pricing2/:orderId/preview  - full computed breakdown (no writes)
router.get('/:orderId/preview', (req, res) => {
  try {
    const id = +req.params.orderId;
    const order = db.prepare('SELECT id, customer_id, final_product_id FROM orders WHERE id=?').get(id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const resv = resolveProfile(order);
    if (!resv.profile_id)
      return res.json({ order_id:id, resolved:resv, breakdown:null,
                        note:'No price profile resolved - set a product default, customer, or order profile.' });
    const profile = db.prepare('SELECT * FROM price_profiles WHERE id=?').get(resv.profile_id);
    const rules   = db.prepare('SELECT * FROM pricing_rules WHERE profile_id=? AND active=1').all(resv.profile_id);
    const pieces  = db.prepare('SELECT w,h,qty,thickness,drill_count,cutout_count FROM order_items WHERE order_id=?').all(id);
    const extras  = db.prepare('SELECT amount,description,category_id FROM order_extra_charges WHERE order_id=?').all(id);
    const dc      = db.prepare('SELECT discount_type,discount_value FROM order_price_choice WHERE order_id=? AND product_id IS NULL').get(id);
    const discount = (dc && dc.discount_type) ? { type:dc.discount_type, value:dc.discount_value } : null;
    const breakdown = computeOrder(profile, pieces, rules, extras, discount);
    res.json({ order_id:id,
      resolved:{ ...resv, profile_name:profile.name, basis:profile.basis, base_rate:profile.base_rate, min_per_piece:profile.min_per_piece },
      pieces: pieces.length, breakdown });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;

