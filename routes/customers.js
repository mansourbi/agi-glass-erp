// routes/customers.js
const router = require('express').Router();
const db     = require('../db');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

router.get('/', (req, res) => {
  try {
    const { search } = req.query;
    let rows;
    if (search) {
      const s = `%${search}%`;
      rows = db.prepare(`
        SELECT c.*, (SELECT COUNT(*) FROM orders WHERE customer_id=c.id) AS order_count
        FROM customers c
        WHERE c.name LIKE ? OR c.code LIKE ? OR c.company LIKE ? OR c.phone LIKE ?
        ORDER BY c.name
      `).all(s, s, s, s);
    } else {
      rows = db.prepare(`
        SELECT c.*, (SELECT COUNT(*) FROM orders WHERE customer_id=c.id) AS order_count
        FROM customers c ORDER BY c.name
      `).all();
    }
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', (req, res) => {
  const row = db.prepare(`
    SELECT c.*, (SELECT COUNT(*) FROM orders WHERE customer_id=c.id) AS order_count
    FROM customers c WHERE c.id=?
  `).get(+req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

router.post('/', (req, res) => {
  try {
    const { code, name, company, phone, email, address, notes } = req.body;
    if (!code || !name || !phone)
      return res.status(400).json({ error: 'code, name, phone required' });
    const exists = db.prepare('SELECT id FROM customers WHERE code=?').get(code.trim().toUpperCase());
    if (exists) return res.status(409).json({ error: 'Customer code already exists' });
    const r = db.prepare(`
      INSERT INTO customers (code,name,company,phone,email,address,notes)
      VALUES (?,?,?,?,?,?,?)
    `).run(code.trim().toUpperCase(), name.trim(), company||null, phone.trim(),
           email||null, address||null, notes||null);
    res.status(201).json(db.prepare('SELECT * FROM customers WHERE id=?').get(r.lastInsertRowid));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id', (req, res) => {
  try {
    const { code, name, company, phone, email, address, notes } = req.body;
    if (!code || !name || !phone)
      return res.status(400).json({ error: 'code, name, phone required' });
    db.prepare(`
      UPDATE customers SET code=?,name=?,company=?,phone=?,email=?,address=?,notes=?,
      updated_at=datetime('now') WHERE id=?
    `).run(code.trim().toUpperCase(), name.trim(), company||null, phone.trim(),
           email||null, address||null, notes||null, +req.params.id);
    res.json(db.prepare('SELECT * FROM customers WHERE id=?').get(+req.params.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', (req, res) => {
  try {
    const hasOrders = db.prepare('SELECT id FROM orders WHERE customer_id=? LIMIT 1').get(+req.params.id);
    if (hasOrders) return res.status(409).json({ error: 'Customer has orders — cannot delete' });
    db.prepare('DELETE FROM customers WHERE id=?').run(+req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
