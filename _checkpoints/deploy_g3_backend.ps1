# ============================================================================
#  BLOCK G-3 backend - finalize / un-finalize (snapshot-freeze) on pricing2.js.
#  Adds order_price_snapshot table (created on load) + 3 endpoints. Route-only.
#  RUN AS ADMINISTRATOR.
# ============================================================================
$ts   = Get-Date -Format 'yyyyMMdd-HHmmss'
$srv  = 'C:\agi-server'
$rdir = Join-Path $srv 'routes'
$rbk  = Join-Path $srv '_route_backups'
New-Item -ItemType Directory -Force -Path $rbk | Out-Null
$routePath = Join-Path $rdir 'pricing2.js'
if (Test-Path $routePath) { Copy-Item $routePath (Join-Path $rbk "pricing2.js.$ts.bak") }
$route = @'
// routes/pricing2.js
// BLOCK E-2 - modular pricing engine, PREVIEW MODE (read-only).
// Computes the new breakdown (profile resolve -> per-piece base+rules ->
// manual extras -> discount -> subtotal) WITHOUT writing anything and WITHOUT
// touching orderpricing.js / value_extras. Safe to run alongside live billing.
const router = require('express').Router();
const db     = require('../db');
const { requireAuth } = require('../middleware/auth');
router.use(requireAuth);

// G-3: snapshot table for finalized order prices (created on load; no live migration)
db.exec("CREATE TABLE IF NOT EXISTS order_price_snapshot ("+
        "order_id INTEGER PRIMARY KEY, snapshot_json TEXT NOT NULL, subtotal REAL,"+
        "finalized_at TEXT NOT NULL, finalized_by TEXT)");

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

// Build the full computed breakdown for an order (shared by preview + finalize)
function buildPreview(id){
  const order = db.prepare('SELECT id, customer_id, final_product_id FROM orders WHERE id=?').get(id);
  if (!order) return { error:'Order not found', status:404 };
  const resv = resolveProfile(order);
  if (!resv.profile_id)
    return { payload:{ order_id:id, resolved:resv, breakdown:null,
                       note:'No price profile resolved - set a product default, customer, or order profile.' } };
  const profile = db.prepare('SELECT * FROM price_profiles WHERE id=?').get(resv.profile_id);
  const rules   = db.prepare('SELECT * FROM pricing_rules WHERE profile_id=? AND active=1').all(resv.profile_id);
  const pieces  = db.prepare('SELECT w,h,qty,thickness,drill_count,cutout_count FROM order_items WHERE order_id=?').all(id);
  const extras  = db.prepare('SELECT amount,description,category_id FROM order_extra_charges WHERE order_id=?').all(id);
  const dc      = db.prepare('SELECT discount_type,discount_value FROM order_price_choice WHERE order_id=? AND product_id IS NULL').get(id);
  const discount = (dc && dc.discount_type) ? { type:dc.discount_type, value:dc.discount_value } : null;
  const breakdown = computeOrder(profile, pieces, rules, extras, discount);
  return { payload:{ order_id:id,
    resolved:{ ...resv, profile_name:profile.name, basis:profile.basis, base_rate:profile.base_rate, min_per_piece:profile.min_per_piece },
    pieces: pieces.length, breakdown } };
}

// GET /api/pricing2/:orderId/preview  - full computed breakdown (no writes)
router.get('/:orderId/preview', (req, res) => {
  try {
    const r = buildPreview(+req.params.orderId);
    if (r.error) return res.status(r.status||500).json({ error:r.error });
    res.json(r.payload);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- BLOCK G-2b: order-level pricing writes (preview tables only; live billing untouched) ----
function _getOrder(id){ return db.prepare('SELECT id FROM orders WHERE id=?').get(id); }

// GET the raw order-level choice (profile override + discount)
router.get('/:orderId/choice', (req,res) => {
  try {
    const id=+req.params.orderId;
    const row=db.prepare('SELECT profile_id, discount_type, discount_value, discount_note FROM order_price_choice WHERE order_id=? AND product_id IS NULL').get(id);
    res.json(row || { profile_id:null, discount_type:null, discount_value:null, discount_note:null });
  } catch(e){ res.status(500).json({error:e.message}); }
});

// PUT set/clear the order-level profile override + discount
router.put('/:orderId/choice', (req,res) => {
  try {
    const id=+req.params.orderId;
    if(!_getOrder(id)) return res.status(404).json({error:'Order not found'});
    const b=req.body||{};
    const profile_id = (b.profile_id===''||b.profile_id==null) ? null : +b.profile_id;
    const dtype = (b.discount_type==='pct'||b.discount_type==='flat') ? b.discount_type : null;
    const dval  = dtype ? (+b.discount_value||0) : null;
    const dnote = b.discount_note || null;
    const existing = db.prepare('SELECT id FROM order_price_choice WHERE order_id=? AND product_id IS NULL').get(id);
    if(profile_id==null && dtype==null){
      if(existing) db.prepare('DELETE FROM order_price_choice WHERE id=?').run(existing.id);
      return res.json({ order_id:id, cleared:true });
    }
    if(existing){
      db.prepare('UPDATE order_price_choice SET profile_id=?, discount_type=?, discount_value=?, discount_note=? WHERE id=?')
        .run(profile_id, dtype, dval, dnote, existing.id);
    } else {
      db.prepare('INSERT INTO order_price_choice(order_id, product_id, profile_id, discount_type, discount_value, discount_note) VALUES(?,NULL,?,?,?,?)')
        .run(id, profile_id, dtype, dval, dnote);
    }
    res.json({ order_id:id, profile_id, discount_type:dtype, discount_value:dval, discount_note:dnote });
  } catch(e){ res.status(500).json({error:e.message}); }
});

// GET the order's manual extra charges
router.get('/:orderId/charges', (req,res) => {
  try {
    const id=+req.params.orderId;
    const rows=db.prepare(`SELECT ec.id, ec.category_id, ec.description, ec.amount, c.label category_label
                           FROM order_extra_charges ec LEFT JOIN extra_charge_categories c ON c.id=ec.category_id
                           WHERE ec.order_id=? ORDER BY ec.id`).all(id);
    res.json(rows);
  } catch(e){ res.status(500).json({error:e.message}); }
});

// POST add a manual extra charge
router.post('/:orderId/charges', (req,res) => {
  try {
    const id=+req.params.orderId;
    if(!_getOrder(id)) return res.status(404).json({error:'Order not found'});
    const b=req.body||{};
    const amount=+b.amount; if(!(amount>0)) return res.status(400).json({error:'amount must be greater than 0'});
    const cat=(b.category_id==null||b.category_id==='')?null:+b.category_id;
    const info=db.prepare("INSERT INTO order_extra_charges(order_id, category_id, description, amount, created_at) VALUES(?,?,?,?,datetime('now'))")
      .run(id, cat, b.description||null, round2(amount));
    res.json(db.prepare('SELECT id, category_id, description, amount FROM order_extra_charges WHERE id=?').get(info.lastInsertRowid));
  } catch(e){ res.status(500).json({error:e.message}); }
});

// DELETE a manual extra charge (scoped to the order)
router.delete('/:orderId/charges/:chargeId', (req,res) => {
  try {
    const id=+req.params.orderId, cid=+req.params.chargeId;
    db.prepare('DELETE FROM order_extra_charges WHERE id=? AND order_id=?').run(cid, id);
    res.json({deleted:cid});
  } catch(e){ res.status(500).json({error:e.message}); }
});

// ---- BLOCK G-3: finalize / un-finalize (snapshot-freeze the computed breakdown) ----
function _who(req){ return (req.user && (req.user.name||req.user.username||req.user.email))||null; }

// GET current snapshot (the frozen price), or finalized:false
router.get('/:orderId/snapshot', (req,res) => {
  try {
    const id=+req.params.orderId;
    const row=db.prepare('SELECT order_id, snapshot_json, subtotal, finalized_at, finalized_by FROM order_price_snapshot WHERE order_id=?').get(id);
    if(!row) return res.json({ order_id:id, finalized:false });
    res.json({ order_id:id, finalized:true, finalized_at:row.finalized_at, finalized_by:row.finalized_by,
               subtotal:row.subtotal, snapshot:JSON.parse(row.snapshot_json) });
  } catch(e){ res.status(500).json({error:e.message}); }
});

// POST finalize: compute the current breakdown and freeze it (upsert)
router.post('/:orderId/finalize', (req,res) => {
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
router.delete('/:orderId/finalize', (req,res) => {
  try {
    const id=+req.params.orderId;
    db.prepare('DELETE FROM order_price_snapshot WHERE order_id=?').run(id);
    res.json({ order_id:id, finalized:false });
  } catch(e){ res.status(500).json({error:e.message}); }
});

module.exports = router;

'@
Set-Content -Path $routePath -Value $route -Encoding ascii
Push-Location $srv; & node --check $routePath; $chk = $LASTEXITCODE; Pop-Location
if ($chk -ne 0) { Write-Host 'ABORT: syntax check failed; restoring.'; Copy-Item (Join-Path $rbk "pricing2.js.$ts.bak") $routePath -Force; exit 1 }
Write-Host ('Wrote ' + $routePath)
Stop-Service agi-glass -Force
Start-Sleep -Seconds 2
$pids = (Get-NetTCPConnection -LocalPort 3444 -State Listen -ErrorAction SilentlyContinue).OwningProcess
foreach ($p in $pids) { taskkill /F /PID $p 2>$null | Out-Null }
Start-Sleep -Seconds 1
Start-Service agi-glass
Start-Sleep -Seconds 4
Write-Host ('agi-glass status: ' + (Get-Service agi-glass).Status)
Write-Host 'G-3 backend live (order_price_snapshot table auto-created on start).'
