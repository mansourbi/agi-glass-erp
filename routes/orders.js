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

// PATCH /api/orders/:id/status
router.patch('/:id/status', (req, res) => {
  try {
    const { status } = req.body;
    if (!['pending','cutting','done'].includes(status))
      return res.status(400).json({ error: 'Invalid status' });
    db.prepare(`UPDATE orders SET status=?,updated_at=datetime('now') WHERE id=?`).run(status, +req.params.id);
    res.json({ ok: true, status });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/orders/:id
router.delete('/:id', (req, res) => {
  try {
    const id = +req.params.id;
    // Block delete if order is part of any active/done optimization
    const optFiles = db.prepare("SELECT id, name, status, order_ids FROM opt_files WHERE status IN ('pending','done')").all();
    const blockedBy = optFiles.find(f => {
      try { return JSON.parse(f.order_ids||'[]').map(Number).includes(id); } catch(e) { return false; }
    });
    if (blockedBy) {
      return res.status(409).json({
        error: 'Cannot delete: order is included in optimization "' + blockedBy.name + '" (status: ' + blockedBy.status + '). Remove it from the optimization first.'
      });
    }
    // Delete child records first to avoid FK constraint failures
    db.prepare('DELETE FROM order_items WHERE order_id=?').run(id);
    try { db.prepare('DELETE FROM label_scan_log WHERE label_uid IN (SELECT uid FROM label_items WHERE order_id=?)').run(id); } catch(e){}
    try { db.prepare('DELETE FROM label_items WHERE order_id=?').run(id); } catch(e){}
    db.prepare('DELETE FROM orders WHERE id=?').run(id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Cancel Reasons CRUD ────────────────────────────────────────────────────
try {
  db.prepare(`CREATE TABLE IF NOT EXISTS cancel_reasons (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    label      TEXT NOT NULL,
    created_at DATETIME DEFAULT (datetime('now','localtime'))
  )`).run();
} catch(e) {}

router.get('/cancel-reasons', (req, res) => {
  try { res.json(db.prepare('SELECT * FROM cancel_reasons ORDER BY label').all()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/cancel-reasons', (req, res) => {
  try {
    const { label } = req.body;
    if (!label) return res.status(400).json({ error: 'label required' });
    const r = db.prepare('INSERT INTO cancel_reasons (label) VALUES (?)').run(label.trim());
    res.status(201).json(db.prepare('SELECT * FROM cancel_reasons WHERE id=?').get(r.lastInsertRowid));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/cancel-reasons/:id', (req, res) => {
  try {
    const { label } = req.body;
    if (!label) return res.status(400).json({ error: 'label required' });
    db.prepare('UPDATE cancel_reasons SET label=? WHERE id=?').run(label.trim(), +req.params.id);
    res.json(db.prepare('SELECT * FROM cancel_reasons WHERE id=?').get(+req.params.id));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/cancel-reasons/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM cancel_reasons WHERE id=?').run(+req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
