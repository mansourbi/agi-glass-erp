// routes/workers.js
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const db     = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');

router.use(requireAuth);

// ── Schema migrations ─────────────────────────────────────────────────────
['hourly_rate','monthly_salary','employment_type','national_id',
 'phone','join_date','dob','notes_hr','vacation_days_balance',
 'social_security_pct','photo_url','documents',
 'device_id','device_verified'].forEach(col => {
  try { db.prepare(`ALTER TABLE workers ADD COLUMN ${col} TEXT`).run(); } catch(e) {}
});

function parseW(w) {
  return {
    ...w,
    processes: JSON.parse(w.processes || '[]'),
    documents: w.documents ? JSON.parse(w.documents) : [],
    hourly_rate: w.hourly_rate ? +w.hourly_rate : null,
    monthly_salary: w.monthly_salary ? +w.monthly_salary : null,
    social_security_pct: w.social_security_pct ? +w.social_security_pct : 0,
    vacation_days_balance: w.vacation_days_balance ? +w.vacation_days_balance : 0,
    device_id: w.device_id || null,
    device_verified: w.device_verified || null
  };
}

// GET / — list workers
router.get('/', requireAdmin, (req, res) => {
  try {
    const rows = db.prepare(
      'SELECT * FROM workers WHERE is_active=1 ORDER BY name'
    ).all();
    res.json(rows.map(parseW));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /:id
router.get('/:id', requireAdmin, (req, res) => {
  try {
    const w = db.prepare('SELECT * FROM workers WHERE id=?').get(+req.params.id);
    if (!w) return res.status(404).json({ error: 'Not found' });
    res.json(parseW(w));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST / — create
router.post('/', requireAdmin, (req, res) => {
  try {
    const { name, email, password, pass, role, processes,
            hourly_rate, monthly_salary, employment_type,
            national_id, phone, join_date, dob, notes_hr, vacation_days_balance,
            social_security_pct, photo_url } = req.body;
    const pwd = password || pass;
    if (!name || !email || !pwd)
      return res.status(400).json({ error: 'name, email, and password required' });
    const hash = bcrypt.hashSync(pwd, 10);
    const r = db.prepare(`INSERT INTO workers
      (name,email,pass_hash,role,processes,hourly_rate,monthly_salary,
       employment_type,national_id,phone,join_date,dob,notes_hr,vacation_days_balance,
       social_security_pct,photo_url)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(name.trim(), email.trim().toLowerCase(), hash, role||'worker',
      JSON.stringify(processes||[]),
      hourly_rate||null, monthly_salary||null, employment_type||'hourly',
      national_id||null, phone||null, join_date||null, dob||null, notes_hr||null,
      vacation_days_balance||0, social_security_pct||0, photo_url||null);
    res.status(201).json(parseW(db.prepare('SELECT * FROM workers WHERE id=?').get(r.lastInsertRowid)));
  } catch(e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Email already exists' });
    res.status(500).json({ error: e.message });
  }
});

// PUT /:id — update
router.put('/:id', (req, res) => {
  try {
    const targetId = +req.params.id;
    if (req.user.role !== 'admin' && req.user.id !== targetId)
      return res.status(403).json({ error: 'Cannot edit another worker' });
    const { name, email, password, pass, role, processes, isActive,
            hourly_rate, monthly_salary, employment_type,
            national_id, phone, join_date, dob, notes_hr, vacation_days_balance,
            social_security_pct, photo_url } = req.body;
    const pwd = password || pass;
    const newRole   = req.user.role === 'admin' ? (role||'worker') : req.user.role;
    const newActive = req.user.role === 'admin' ? (isActive !== false ? 1 : 0) : 1;
    const base = [name.trim(), email.trim().toLowerCase(), newRole,
      JSON.stringify(processes||[]), newActive,
      hourly_rate||null, monthly_salary||null, employment_type||'hourly',
      national_id||null, phone||null, join_date||null, dob||null, notes_hr||null,
      vacation_days_balance||0, social_security_pct||0, photo_url||null, targetId];
    if (pwd) {
      const hash = bcrypt.hashSync(pwd, 10);
      db.prepare(`UPDATE workers SET name=?,email=?,role=?,processes=?,is_active=?,
        hourly_rate=?,monthly_salary=?,employment_type=?,national_id=?,phone=?,
        join_date=?,dob=?,notes_hr=?,vacation_days_balance=?,social_security_pct=?,photo_url=?,
        pass_hash=?,updated_at=datetime('now') WHERE id=?`).run(...base.slice(0,-1), hash, targetId);
    } else {
      db.prepare(`UPDATE workers SET name=?,email=?,role=?,processes=?,is_active=?,
        hourly_rate=?,monthly_salary=?,employment_type=?,national_id=?,phone=?,
        join_date=?,dob=?,notes_hr=?,vacation_days_balance=?,social_security_pct=?,photo_url=?,
        updated_at=datetime('now') WHERE id=?`).run(...base);
    }
    res.json(parseW(db.prepare('SELECT * FROM workers WHERE id=?').get(targetId)));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /:id — soft delete
router.delete('/:id', requireAdmin, (req, res) => {
  try {
    if (+req.params.id === req.user.id)
      return res.status(400).json({ error: 'Cannot delete your own account' });
    db.prepare(`UPDATE workers SET is_active=0,updated_at=datetime('now') WHERE id=?`).run(+req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /:id/payroll?month=YYYY-MM — calculate payroll for a worker
router.get('/:id/payroll', requireAdmin, (req, res) => {
  try {
    const { month } = req.query;
    const w = db.prepare('SELECT * FROM workers WHERE id=?').get(+req.params.id);
    if (!w) return res.status(404).json({ error: 'Not found' });
    const hourlyRate = +w.hourly_rate || 0;
    const rows = db.prepare(
      "SELECT * FROM attendance WHERE worker_id=? AND date LIKE ? AND punch_in IS NOT NULL"
    ).all(+req.params.id, (month||new Date().toISOString().slice(0,7))+'%');

    let regularMins = 0, overtimeMins = 0, vacationMins = 0;
    rows.forEach(r => {
      const mins = r.total_mins || 0;
      const stdMins = 8 * 60; // 8hr standard day
      if (r.note && r.note.includes('vacation')) {
        vacationMins += mins;
      } else if (mins > stdMins) {
        regularMins  += stdMins;
        overtimeMins += mins - stdMins;
      } else {
        regularMins += mins;
      }
    });

    const regularPay  = (regularMins  / 60) * hourlyRate;
    const overtimePay = (overtimeMins / 60) * hourlyRate * 1.25;  // +25%
    const vacationPay = (vacationMins / 60) * hourlyRate * 1.50;  // +50%
    const totalPay    = regularPay + overtimePay + vacationPay;

    res.json({
      worker_id: w.id, worker_name: w.name,
      month: month||new Date().toISOString().slice(0,7),
      days_worked: rows.length,
      regular_hours:  +(regularMins/60).toFixed(2),
      overtime_hours: +(overtimeMins/60).toFixed(2),
      vacation_hours: +(vacationMins/60).toFixed(2),
      hourly_rate: hourlyRate,
      regular_pay:  +regularPay.toFixed(2),
      overtime_pay: +overtimePay.toFixed(2),
      vacation_pay: +vacationPay.toFixed(2),
      total_pay:    +totalPay.toFixed(2)
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /:id/documents — add document metadata
router.post('/:id/documents', requireAdmin, (req, res) => {
  try {
    const w = db.prepare('SELECT * FROM workers WHERE id=?').get(+req.params.id);
    if (!w) return res.status(404).json({ error: 'Not found' });
    const docs = w.documents ? JSON.parse(w.documents) : [];
    docs.push({ ...req.body, added_at: new Date().toISOString().slice(0,10) });
    db.prepare('UPDATE workers SET documents=? WHERE id=?').run(JSON.stringify(docs), +req.params.id);
    res.json(docs);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /:id/documents/:docIdx
router.delete('/:id/documents/:idx', requireAdmin, (req, res) => {
  try {
    const w = db.prepare('SELECT * FROM workers WHERE id=?').get(+req.params.id);
    if (!w) return res.status(404).json({ error: 'Not found' });
    const docs = w.documents ? JSON.parse(w.documents) : [];
    docs.splice(+req.params.idx, 1);
    db.prepare('UPDATE workers SET documents=? WHERE id=?').run(JSON.stringify(docs), +req.params.id);
    res.json(docs);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /:id/register-device — called on every worker login from mobile
// First call: stores device_id with status 'pending' (admin must verify)
// Subsequent calls from same device: returns 'verified' or 'pending'
// Called by worker themselves (not admin-only)
router.post('/:id/register-device', (req, res) => {
  try {
    const targetId = +req.params.id;
    // Workers can only register their own device
    if (req.user.id !== targetId && req.user.role !== 'admin')
      return res.status(403).json({ error: 'Forbidden' });
    const { device_id } = req.body;
    if (!device_id) return res.status(400).json({ error: 'device_id required' });
    const w = db.prepare('SELECT * FROM workers WHERE id=?').get(targetId);
    if (!w) return res.status(404).json({ error: 'Not found' });
    // First registration — store and mark pending
    if (!w.device_id) {
      db.prepare("UPDATE workers SET device_id=?,device_verified='pending',updated_at=datetime('now') WHERE id=?")
        .run(device_id, targetId);
      return res.json({ status: 'pending', device_id, message: 'Device registered, awaiting admin approval' });
    }
    // Same device — return current status
    if (w.device_id === device_id) {
      return res.json({ status: w.device_verified || 'pending', device_id });
    }
    // Different device — reject
    if (w.device_verified === 'approved') {
      return res.json({ status: 'rejected', message: 'Device not recognized. Contact admin.' });
    }
    // Device pending but different device — update to new device (overwrite while still pending)
    db.prepare("UPDATE workers SET device_id=?,device_verified='pending',updated_at=datetime('now') WHERE id=?")
      .run(device_id, targetId);
    return res.json({ status: 'pending', device_id, message: 'New device registered, awaiting admin approval' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PATCH /:id/verify-device — admin approves or resets device
router.patch('/:id/verify-device', requireAdmin, (req, res) => {
  try {
    const { action } = req.body; // 'approve' | 'reset'
    const targetId = +req.params.id;
    if (action === 'approve') {
      db.prepare("UPDATE workers SET device_verified='approved',updated_at=datetime('now') WHERE id=?").run(targetId);
    } else if (action === 'reset') {
      db.prepare("UPDATE workers SET device_id=NULL,device_verified=NULL,updated_at=datetime('now') WHERE id=?").run(targetId);
    }
    const w = db.prepare('SELECT * FROM workers WHERE id=?').get(targetId);
    res.json(parseW(w));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
