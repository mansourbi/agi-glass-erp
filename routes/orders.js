// routes/orders.js
const router = require('express').Router();
const db     = require('../db');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

// GET /api/orders
router.get('/', (req, res) => {
  try {
    const { status, customerId } = req.query;
    let sql = `
      SELECT o.*,
        c.name AS customer_name, c.code AS customer_code, c.company AS customer_company,
        (SELECT COUNT(*) FROM order_items WHERE order_id=o.id) AS line_items,
        (SELECT COALESCE(SUM(qty),0) FROM order_items WHERE order_id=o.id) AS total_pieces,
        (SELECT COALESCE(SUM(w*h*qty),0) FROM order_items WHERE order_id=o.id)/1000000.0 AS total_sqm
      FROM orders o
      JOIN customers c ON c.id=o.customer_id
      WHERE 1=1
    `;
    const params = [];
    if (status)     { sql += ' AND o.status=?';      params.push(status); }
    if (customerId) { sql += ' AND o.customer_id=?'; params.push(+customerId); }
    sql += ' ORDER BY o.id DESC';
    res.json(db.prepare(sql).all(...params).map(r=>({...r, customerId: r.customer_id, finalProductId: r.final_product_id, attachments: JSON.parse(r.attachments||'[]')})));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/orders/:id — full order with items
router.get('/:id', (req, res) => {
  try {
    const order = db.prepare(`
      SELECT o.*, c.name AS customer_name, c.code AS customer_code, c.company AS customer_company
      FROM orders o JOIN customers c ON c.id=o.customer_id WHERE o.id=?
    `).get(+req.params.id);
    if (!order) return res.status(404).json({ error: 'Not found' });
    const items = db.prepare('SELECT * FROM order_items WHERE order_id=? ORDER BY sort_order,id').all(+req.params.id);
    order.items = items.map(i => ({
      ...i,
      processes:  JSON.parse(i.processes  || '[]'),
      pieceUIDs:  JSON.parse(i.piece_uids || '[]'),
      piece_uids: JSON.parse(i.piece_uids || '[]'),
      glassType:  i.glass_type,
      bevelMM:    i.bevel_mm,
      startSerial:i.start_serial,
      attachments: []
    }));
    order.attachments = JSON.parse(order.attachments || '[]');
    order.customerId = order.customer_id;
    order.finalProductId = order.final_product_id;
    res.json(order);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/orders
router.post('/', (req, res) => {
  try {
    const { customerId, date, extref, notes, items, attachments, finalProductId } = req.body;
    if (!customerId || !date || !Array.isArray(items) || !items.length)
      return res.status(400).json({ error: 'customerId, date, items[] required' });

    const customer = db.prepare('SELECT * FROM customers WHERE id=?').get(+customerId);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    // Auto-number: use MAX to avoid duplicates from deleted orders
    const existing = db.prepare("SELECT num FROM orders WHERE customer_id=? ORDER BY id DESC").all(+customerId);
    let maxN = 0;
    existing.forEach(r => {
      const parts = r.num.split('-');
      const n = parseInt(parts[parts.length - 1]);
      if (!isNaN(n) && n > maxN) maxN = n;
    });
    let nextN = maxN + 1;
    let orderNum = customer.code + '-' + nextN;
    while (db.prepare('SELECT id FROM orders WHERE num=?').get(orderNum)) {
      nextN++;
      orderNum = customer.code + '-' + nextN;
    }

    const insertOrder = db.transaction(() => {
      const r = db.prepare(`
        INSERT INTO orders (num, customer_id, date, extref, notes, status, attachments)
        VALUES (?,?,?,?,?,?,?)
      `).run(orderNum, +customerId, date, extref||null, notes||null, 'pending',
             JSON.stringify(attachments||[]));
      if(finalProductId) db.prepare('UPDATE orders SET final_product_id=? WHERE id=?').run(+finalProductId, r.lastInsertRowid);
      const orderId = r.lastInsertRowid;

      let globalSerial = 1;
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const qty = Math.max(1, +it.qty || 1);
        // Generate piece UIDs: e.g. REF-1-1, REF-1-2
        const uids = [];
        for (let q = 0; q < qty; q++) {
          uids.push(`${orderNum}-${globalSerial}`);
          globalSerial++;
        }
        db.prepare(`
          INSERT INTO order_items
            (order_id,code,w,h,thickness,glass_type,color,qty,processes,bevel_mm,sort_order,piece_uids,start_serial)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        `).run(
          orderId, (it.code||'PC').toUpperCase(), +it.w, +it.h,
          +it.thickness||6, it.glassType||it.glass_type||'glass',
          it.color||'clear', qty,
          JSON.stringify(it.processes||[]),
          +it.bevelMM||+it.bevel_mm||0, i,
          JSON.stringify(uids), uids[0] ? +uids[0].split('-').pop() : globalSerial - qty
        );
      }
      return orderId;
    });

    const orderId = insertOrder();
    res.status(201).json(db.prepare(`
      SELECT o.*, c.name AS customer_name, c.code AS customer_code
      FROM orders o JOIN customers c ON c.id=o.customer_id WHERE o.id=?
    `).get(orderId));
  } catch (e) {
    console.error('[orders POST]', e);
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/orders/:id — full update
router.put('/:id', (req, res) => {
  try {
    const { customerId, date, extref, notes, items, attachments, finalProductId } = req.body;
    if (!customerId || !date || !Array.isArray(items) || !items.length)
      return res.status(400).json({ error: 'customerId, date, items[] required' });

    const customer = db.prepare('SELECT * FROM customers WHERE id=?').get(+customerId);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const order = db.prepare('SELECT * FROM orders WHERE id=?').get(+req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const updateOrder = db.transaction(() => {
      db.prepare(`
        UPDATE orders SET customer_id=?,date=?,extref=?,notes=?,attachments=?,updated_at=datetime('now')
        WHERE id=?
      `).run(+customerId, date, extref||null, notes||null, JSON.stringify(attachments||[]), +req.params.id);

      // Delete old items and re-insert
      db.prepare('DELETE FROM order_items WHERE order_id=?').run(+req.params.id);

      // Re-number pieces using existing order num
      let globalSerial = 1;
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const qty = Math.max(1, +it.qty || 1);
        const uids = [];
        for (let q = 0; q < qty; q++) {
          uids.push(`${order.num}-${globalSerial}`);
          globalSerial++;
        }
        db.prepare(`
          INSERT INTO order_items
            (order_id,code,w,h,thickness,glass_type,color,qty,processes,bevel_mm,sort_order,piece_uids,start_serial)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        `).run(
          +req.params.id, (it.code||'PC').toUpperCase(), +it.w, +it.h,
          +it.thickness||6, it.glassType||it.glass_type||'glass',
          it.color||'clear', qty,
          JSON.stringify(it.processes||[]),
          +it.bevelMM||+it.bevel_mm||0, i,
          JSON.stringify(uids), uids[0] ? +uids[0].split('-').pop() : globalSerial - qty
        );
      }
    });

    updateOrder();
    res.json(db.prepare(`
      SELECT o.*, c.name AS customer_name, c.code AS customer_code
      FROM orders o JOIN customers c ON c.id=o.customer_id WHERE o.id=?
    `).get(+req.params.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Schema migrations for cancel fields ──────────────────────────────────
['cancel_reason','cancelled_at','cancelled_by','completed_at','completed_by'].forEach(col => {
  try { db.prepare(`ALTER TABLE orders ADD COLUMN ${col} TEXT`).run(); } catch(e) {}
});

// ── Schema: cancel_reasons table ─────────────────────────────────────────
try {
  db.prepare(`CREATE TABLE IF NOT EXISTS cancel_reasons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`).run();
  // Seed defaults if empty
  const cnt = db.prepare('SELECT COUNT(*) as n FROM cancel_reasons').get().n;
  if(cnt === 0){
    ['Customer Request','Duplicate Order','Pricing Issue','Material Unavailable','Design Change','Other'].forEach((l,i) => {
      db.prepare('INSERT INTO cancel_reasons (label,sort_order) VALUES (?,?)').run(l, i);
    });
  }
} catch(e) {}

// GET /api/orders/cancel-reasons
router.get('/cancel-reasons', (req, res) => {
  try {
    res.json(db.prepare('SELECT * FROM cancel_reasons ORDER BY sort_order,id').all());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/orders/cancel-reasons
router.post('/cancel-reasons', (req, res) => {
  try {
    const { label } = req.body;
    if(!label) return res.status(400).json({ error: 'label required' });
    const cnt = db.prepare('SELECT COUNT(*) as n FROM cancel_reasons').get().n;
    const r = db.prepare('INSERT INTO cancel_reasons (label,sort_order) VALUES (?,?)').run(label.trim(), cnt);
    res.json(db.prepare('SELECT * FROM cancel_reasons WHERE id=?').get(r.lastInsertRowid));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/orders/cancel-reasons/:id
router.put('/cancel-reasons/:id', (req, res) => {
  try {
    const { label } = req.body;
    db.prepare('UPDATE cancel_reasons SET label=? WHERE id=?').run(label.trim(), +req.params.id);
    res.json(db.prepare('SELECT * FROM cancel_reasons WHERE id=?').get(+req.params.id));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/orders/cancel-reasons/:id
router.delete('/cancel-reasons/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM cancel_reasons WHERE id=?').run(+req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/orders/:id/status
router.patch('/:id/status', (req, res) => {
  try {
    const { status, cancel_reason, cancelled_by } = req.body;
    if (!['pending','cutting','done','cancelled'].includes(status))
      return res.status(400).json({ error: 'Invalid status' });
    if (status === 'cancelled') {
      db.prepare(`UPDATE orders SET status=?,cancel_reason=?,cancelled_at=datetime('now'),cancelled_by=?,updated_at=datetime('now') WHERE id=?`)
        .run('cancelled', cancel_reason||null, cancelled_by||null, +req.params.id);
    } else if (status === 'done') {
      db.prepare(`UPDATE orders SET status='done',completed_at=datetime('now'),completed_by=?,updated_at=datetime('now') WHERE id=?`)
        .run(cancelled_by||null, +req.params.id);  // reuse cancelled_by param as actor
    } else {
      // Restoring to pending/cutting clears cancel fields
      db.prepare(`UPDATE orders SET status=?,cancel_reason=NULL,cancelled_at=NULL,cancelled_by=NULL,updated_at=datetime('now') WHERE id=?`)
        .run(status, +req.params.id);
    }
    res.json({ ok: true, status });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/orders/:id
router.delete('/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM orders WHERE id=?').run(+req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
