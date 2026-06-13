// routes/customerprices.js
// Per-customer price overrides (Phase 2 of pricing build).
// Waterfall: Customer Order Price > Customer Price (THIS) > General Price (final_products.general_price_sqm).
// Stores ONLY explicit overrides — absence of a row means "use the General Price".
const router = require('express').Router();
const db     = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
router.use(requireAuth);

// ── Idempotent self-migration ──────────────────────────────
try {
  db.prepare(`CREATE TABLE IF NOT EXISTS customer_prices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    final_product_id INTEGER NOT NULL,
    price_sqm REAL NOT NULL,
    created_at DATETIME DEFAULT (datetime('now')),
    updated_at DATETIME DEFAULT (datetime('now')),
    UNIQUE(customer_id, final_product_id)
  )`).run();
} catch (e) { console.error('[customerprices] table init', e.message); }

// Helper: hydrate an override row with the FP label/serial/general price for display
const SELECT_WITH_FP = `
  SELECT cp.id, cp.customer_id, cp.final_product_id, cp.price_sqm,
         cp.created_at, cp.updated_at,
         fp.label AS fp_label, fp.serial AS fp_serial,
         fp.general_price_sqm AS fp_general_price, fp.active AS fp_active
  FROM customer_prices cp
  JOIN final_products fp ON fp.id = cp.final_product_id
`;

// GET /api/customerprices?customer_id=NN  → that customer's overrides (hydrated)
// GET /api/customerprices                  → all overrides (admin overview, hydrated)
router.get('/', (req, res) => {
  try {
    const cid = req.query.customer_id ? +req.query.customer_id : null;
    const rows = cid
      ? db.prepare(SELECT_WITH_FP + ' WHERE cp.customer_id=? ORDER BY fp.label').all(cid)
      : db.prepare(SELECT_WITH_FP + ' ORDER BY cp.customer_id, fp.label').all();
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/customerprices/resolve?customer_id=NN&final_product_id=MM
// → { price_sqm, source } where source ∈ {'customer','general','none'}.
// Read-only price resolution helper (the order-level resolver in Phase 3 will use this same logic).
router.get('/resolve', (req, res) => {
  try {
    const cid = +req.query.customer_id, fpId = +req.query.final_product_id;
    if (!cid || !fpId) return res.status(400).json({ error: 'customer_id and final_product_id are required' });
    const ov = db.prepare('SELECT price_sqm FROM customer_prices WHERE customer_id=? AND final_product_id=?').get(cid, fpId);
    if (ov && ov.price_sqm != null) return res.json({ price_sqm: ov.price_sqm, source: 'customer' });
    const fp = db.prepare('SELECT general_price_sqm FROM final_products WHERE id=?').get(fpId);
    if (fp && fp.general_price_sqm != null && fp.general_price_sqm > 0)
      return res.json({ price_sqm: fp.general_price_sqm, source: 'general' });
    return res.json({ price_sqm: null, source: 'none' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/customerprices  { customer_id, final_product_id, price_sqm }
// Upsert: add a new override or update the existing one for this (customer, product) pair.
router.post('/', requireAdmin, (req, res) => {
  try {
    const cid  = +req.body.customer_id;
    const fpId = +req.body.final_product_id;
    const price = Number(req.body.price_sqm);
    if (!cid || !fpId) return res.status(400).json({ error: 'customer_id and final_product_id are required' });
    if (!Number.isFinite(price) || price < 0) return res.status(400).json({ error: 'price_sqm must be a number ≥ 0' });

    // validate FK targets exist
    const cust = db.prepare('SELECT id FROM customers WHERE id=?').get(cid);
    if (!cust) return res.status(404).json({ error: 'Customer not found' });
    const fp = db.prepare('SELECT id FROM final_products WHERE id=?').get(fpId);
    if (!fp) return res.status(404).json({ error: 'Final product not found' });

    const existing = db.prepare('SELECT id FROM customer_prices WHERE customer_id=? AND final_product_id=?').get(cid, fpId);
    if (existing) {
      db.prepare("UPDATE customer_prices SET price_sqm=?, updated_at=datetime('now') WHERE id=?").run(price, existing.id);
    } else {
      db.prepare('INSERT INTO customer_prices (customer_id, final_product_id, price_sqm) VALUES (?,?,?)').run(cid, fpId, price);
    }
    const row = db.prepare(SELECT_WITH_FP + ' WHERE cp.customer_id=? AND cp.final_product_id=?').get(cid, fpId);
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/customerprices/:id           → remove by override row id
// DELETE /api/customerprices?customer_id=&final_product_id=  → remove by pair
router.delete('/:id', requireAdmin, (req, res) => {
  try {
    db.prepare('DELETE FROM customer_prices WHERE id=?').run(+req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/', requireAdmin, (req, res) => {
  try {
    const cid = +req.query.customer_id, fpId = +req.query.final_product_id;
    if (!cid || !fpId) return res.status(400).json({ error: 'customer_id and final_product_id are required' });
    db.prepare('DELETE FROM customer_prices WHERE customer_id=? AND final_product_id=?').run(cid, fpId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
