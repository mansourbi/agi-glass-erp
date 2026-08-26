
// routes/orderpricing.js
// Order-level price snapshot (Phase 3 of pricing build).
// Freeze-at-save: the order modal calls POST after saveOrder() succeeds.
// Waterfall: customer_order_price > customer_prices > final_products.general_price_sqm.
const router = require('express').Router();
const db     = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
let _engine=null; try { _engine = require('./pricing2').engine; } catch(e) { console.warn('[orderpricing] engine unavailable:', e.message); }
router.use(requireAuth);

// ── Idempotent migration: add snapshot columns to orders ──
try {
  const cols = db.prepare("PRAGMA table_info(orders)").all().map(c => c.name);
  const addCol = (name, decl) => {
    if (!cols.includes(name)) { db.prepare(`ALTER TABLE orders ADD COLUMN ${name} ${decl}`).run(); cols.push(name); }
  };
  addCol('customer_order_price', 'REAL');   // top-tier per-order override (nullable)
  addCol('price_sqm',   'REAL');            // resolved price/m² used
  addCol('price_source','TEXT');            // 'order' | 'customer' | 'general' | 'none'
  addCol('area_sqm',    'REAL');            // Σ(w·h·qty)/1e6, ceil to 0.01
  addCol('value_base',  'REAL');            // price_sqm × area_sqm
  addCol('value_extras','REAL DEFAULT 0');  // deferred (drilling/cutouts) — 0 for now
  addCol('subtotal',    'REAL');            // value_base + value_extras
  addCol('priced_at',   'DATETIME');        // when frozen
} catch (e) { console.error('[orderpricing] migration', e.message); }

// Round helpers
const ceil2 = n => Math.ceil((n + Number.EPSILON) * 100) / 100;
const r2    = n => Math.round((n + Number.EPSILON) * 100) / 100;

// Shared resolver — order → customer → general → none
function resolvePrice(customerOrderPrice, customerId, fpId) {
  const cop = (customerOrderPrice == null || customerOrderPrice === '') ? null : Number(customerOrderPrice);
  if (cop != null && isFinite(cop) && cop >= 0) return { price: cop, source: 'order' };
  if (customerId && fpId) {
    const ov = db.prepare('SELECT price_sqm FROM customer_prices WHERE customer_id=? AND final_product_id=?').get(customerId, fpId);
    if (ov && ov.price_sqm != null) return { price: ov.price_sqm, source: 'customer' };
  }
  if (fpId) {
    const fp = db.prepare('SELECT general_price_sqm FROM final_products WHERE id=?').get(fpId);
    if (fp && fp.general_price_sqm != null && fp.general_price_sqm > 0) return { price: fp.general_price_sqm, source: 'general' };
  }
  return { price: null, source: 'none' };
}

// Compute billable area from the order's own items
function computeArea(orderId) {
  const rows = db.prepare('SELECT w, h, qty FROM order_items WHERE order_id=?').all(orderId);
  let sum = 0;
  for (const r of rows) sum += ((+r.w || 0) * (+r.h || 0) * (+r.qty || 0)) / 1e6;
  return ceil2(sum);
}

// Core snapshot builder (used by POST and the read endpoint's recompute=1)
function buildSnapshot(orderId, customerOrderPrice) {
  const order = db.prepare('SELECT id, customer_id, final_product_id FROM orders WHERE id=?').get(orderId);
  if (!order) return null;
  const area = computeArea(orderId);
  // Engine-first: minimums, oversize, rule extras, manual fees, discount all included.
  if (_engine) {
    try {
      const pv = _engine.buildPreview(orderId, { rate_override: customerOrderPrice });
      const bd = pv && pv.payload && pv.payload.breakdown;
      if (bd) {
        const rv = pv.payload.resolved || {};
        return {
          customer_order_price: (customerOrderPrice == null || customerOrderPrice === '') ? null : Number(customerOrderPrice),
          price_sqm: (rv.override_rate != null) ? rv.override_rate : rv.base_rate,
          price_source: rv.source || 'engine',
          area_sqm: area,
          value_base: r2(bd.value_base),
          value_extras: r2((+bd.value_oversize||0) + (+bd.value_rule_extras||0) + (+bd.manual_extras||0) + (+bd.ext_sell||0) - (+bd.discount||0)),
          subtotal: r2(bd.subtotal)
        };
      }
    } catch (e) { console.warn('[orderpricing] engine compute failed, falling back:', e.message); }
  }
  // Legacy fallback (no profile and no order rate): unchanged behaviour.
  const { price, source } = resolvePrice(customerOrderPrice, order.customer_id, order.final_product_id);
  const value_base = (price == null) ? null : r2(price * area);
  const value_extras = 0;
  const subtotal = (value_base == null) ? null : r2(value_base + value_extras);
  return {
    customer_order_price: (customerOrderPrice == null || customerOrderPrice === '') ? null : Number(customerOrderPrice),
    price_sqm: price, price_source: source, area_sqm: area,
    value_base, value_extras, subtotal
  };
}

// GET /api/orderpricing/:orderId  → stored snapshot (and a live preview)
router.get('/:orderId', (req, res) => {
  try {
    const id = +req.params.orderId;
    const stored = db.prepare(`SELECT customer_order_price, price_sqm, price_source, area_sqm,
                                      value_base, value_extras, subtotal, priced_at
                               FROM orders WHERE id=?`).get(id);
    if (!stored) return res.status(404).json({ error: 'Order not found' });
    res.json(stored);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/orderpricing/:orderId  { customer_order_price }  → resolve + freeze
router.post('/:orderId', requireAdmin, (req, res) => {
  try {
    const id = +req.params.orderId;
    const snap = buildSnapshot(id, req.body.customer_order_price);
    if (!snap) return res.status(404).json({ error: 'Order not found' });
    db.prepare(`UPDATE orders SET
        customer_order_price=?, price_sqm=?, price_source=?, area_sqm=?,
        value_base=?, value_extras=?, subtotal=?, priced_at=datetime('now')
      WHERE id=?`).run(
        snap.customer_order_price, snap.price_sqm, snap.price_source, snap.area_sqm,
        snap.value_base, snap.value_extras, snap.subtotal, id);
    const out = db.prepare(`SELECT customer_order_price, price_sqm, price_source, area_sqm,
                                   value_base, value_extras, subtotal, priced_at
                            FROM orders WHERE id=?`).get(id);
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;