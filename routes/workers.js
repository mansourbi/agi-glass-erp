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
 'vac_days_junior','vac_days_senior'].forEach(col => {
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
    vac_days_junior: w.vac_days_junior ? +w.vac_days_junior : 14,
    vac_days_senior: w.vac_days_senior ? +w.vac_days_senior : 21
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
    const newId = r.lastInsertRowid;
    // Mirror the vacation balance to the vacation_balance table (the source of truth for payroll)
    try {
      db.prepare(`INSERT INTO vacation_balance (worker_id, worker_name, balance_days, accrual_rate, updated_at)
        VALUES (?, ?, ?, ?, datetime('now','localtime'))
        ON CONFLICT(worker_id) DO UPDATE SET balance_days=excluded.balance_days, worker_name=excluded.worker_name, updated_at=excluded.updated_at`)
        .run(newId, name.trim(), +vacation_days_balance||0, 1.6667);
    } catch(e) { /* vacation_balance table may not exist yet; skip */ }
    res.status(201).json(parseW(db.prepare('SELECT * FROM workers WHERE id=?').get(newId)));
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
            social_security_pct, photo_url,
            vac_days_junior, vac_days_senior } = req.body;
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
    // Mirror the vacation balance to the vacation_balance table (the source of truth for payroll).
    // Only admin can set this via this endpoint; a worker editing their own profile should
    // not accidentally overwrite their banked balance. The UI normally hides the field from workers.
    if (req.user.role === 'admin') {
      try {
        db.prepare(`INSERT INTO vacation_balance (worker_id, worker_name, balance_days, accrual_rate, updated_at)
          VALUES (?, ?, ?, ?, datetime('now','localtime'))
          ON CONFLICT(worker_id) DO UPDATE SET balance_days=excluded.balance_days, worker_name=excluded.worker_name, updated_at=excluded.updated_at`)
          .run(targetId, name.trim(), +vacation_days_balance||0, 1.6667);
      } catch(e) { /* vacation_balance table may not exist yet; skip */ }
    }
    if (vac_days_junior !== undefined || vac_days_senior !== undefined) {
      try { db.prepare('UPDATE workers SET vac_days_junior=?, vac_days_senior=? WHERE id=?').run(+vac_days_junior||14, +vac_days_senior||21, targetId); } catch(e) {}
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
// Scheme (per factory rules):
//  - Normal day, first 8h       → 100% Regular
//  - Normal day, OT beyond 8h   → 125% (ONLY if overtime_status='approved')
//  - Weekend day, all hours     → 150% (ONLY if overtime_status='approved')
//  - Holiday day, all hours     → 150% (ONLY if overtime_status='approved')
//  - Approved paid leave        → 100% (deducts from vacation balance elsewhere)
router.get('/:id/payroll', requireAdmin, (req, res) => {
  try {
    const { month } = req.query;
    const w = db.prepare('SELECT * FROM workers WHERE id=?').get(+req.params.id);
    if (!w) return res.status(404).json({ error: 'Not found' });
    const hourlyRate = +w.hourly_rate || 0;
    const monthFilter = month || new Date().toISOString().slice(0,7);

    // Attendance rows in month
    const attRows = db.prepare(
      "SELECT * FROM attendance WHERE worker_id=? AND date LIKE ? AND punch_in IS NOT NULL"
    ).all(+req.params.id, monthFilter + '%');

    const STD_MINS = 8 * 60;
    let regularMins = 0;          // normal day, <=8h
    let otNormalMins = 0;         // normal day, approved OT beyond 8h
    let weekendMins = 0;          // weekend, approved
    let holidayMins = 0;          // holiday, approved
    let unapprovedOtMins = 0;     // FYI: pending/none/rejected OT on non-normal OR beyond 8h normal
    let absentDays = 0;

    attRows.forEach(r => {
      const mins = +r.total_mins || 0;
      if (mins <= 0) { absentDays += 1; return; }
      const dt = (r.day_type || 'normal').toLowerCase();
      const otApproved = r.overtime_status === 'approved';

      if (dt === 'weekend') {
        if (otApproved) weekendMins += mins;
        else           unapprovedOtMins += mins;
      } else if (dt === 'holiday') {
        if (otApproved) holidayMins += mins;
        else           unapprovedOtMins += mins;
      } else { // normal
        if (mins <= STD_MINS) {
          regularMins += mins;
        } else {
          regularMins += STD_MINS;
          const excess = mins - STD_MINS;
          if (otApproved) otNormalMins += excess;
          else           unapprovedOtMins += excess;
        }
      }
    });

    // Paid leave hours (approved + leave_type.is_paid=1). Treat as 8h/day for vacation-kind,
    // exact hours for hourly-kind.
    const leaveRows = db.prepare(`
      SELECT lr.days, lr.hours, lr.leave_kind
      FROM leave_requests lr
      LEFT JOIN leave_types lt ON lower(trim(lt.label)) = lower(trim(lr.type))
      WHERE lr.worker_id = ?
        AND lr.status = 'approved'
        AND COALESCE(lt.is_paid, 1) = 1
        AND (
          (lr.leave_kind = 'hourly' AND lr.date_from LIKE ?) OR
          (lr.leave_kind != 'hourly' AND (lr.date_from LIKE ? OR lr.date_to LIKE ?))
        )
    `).all(+req.params.id, monthFilter + '%', monthFilter + '%', monthFilter + '%');
    let leaveMins = 0;
    leaveRows.forEach(lr => {
      if (lr.leave_kind === 'hourly') leaveMins += Math.round((+lr.hours || 0) * 60);
      else                             leaveMins += Math.round((+lr.days  || 0) * STD_MINS);
    });

    // Pay calculations
    const regularPay   = (regularMins   / 60) * hourlyRate * 1.00;
    const otNormalPay  = (otNormalMins  / 60) * hourlyRate * 1.25;
    const weekendPay   = (weekendMins   / 60) * hourlyRate * 1.50;
    const holidayPay   = (holidayMins   / 60) * hourlyRate * 1.50;
    const leavePay     = (leaveMins     / 60) * hourlyRate * 1.00;
    const totalPay     = regularPay + otNormalPay + weekendPay + holidayPay + leavePay;

    res.json({
      worker_id: w.id,
      worker_name: w.name,
      month: monthFilter,
      hourly_rate: hourlyRate,
      days_worked: attRows.length,
      // Hour breakdown (field names matched to frontend)
      regular_hours:  +(regularMins   / 60).toFixed(2),
      overtime_hours: +(otNormalMins  / 60).toFixed(2),
      weekend_hours:  +(weekendMins   / 60).toFixed(2),
      holiday_hours:  +(holidayMins   / 60).toFixed(2),
      leave_hours:    +(leaveMins     / 60).toFixed(2),
      unapproved_ot_hours: +(unapprovedOtMins / 60).toFixed(2),
      // Pay breakdown
      regular_pay:    +regularPay.toFixed(2),
      overtime_pay:   +otNormalPay.toFixed(2),
      weekend_pay:    +weekendPay.toFixed(2),
      holiday_pay:    +holidayPay.toFixed(2),
      leave_pay:      +leavePay.toFixed(2),
      total_pay:      +totalPay.toFixed(2)
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

module.exports = router;

// ── Device Binding ──────────────────────────────────────────────────────────
// POST /:id/register-device  — called on worker login from worker app
router.post('/:id/register-device', (req, res) => {
  try {
    const { device_id } = req.body;
    if (!device_id) return res.status(400).json({ error: 'device_id required' });
    const w = db.prepare('SELECT * FROM workers WHERE id=?').get(+req.params.id);
    if (!w) return res.status(404).json({ error: 'Not found' });

    const existing_device = w.device_id;
    const existing_status = w.device_status; // null | 'pending' | 'approved' | 'rejected'

    // First registration — store as pending
    if (!existing_device) {
      db.prepare('UPDATE workers SET device_id=?, device_status=?, device_registered_at=? WHERE id=?')
        .run(device_id, 'pending', new Date().toISOString(), +req.params.id);
      return res.json({ status: 'pending', message: 'Device registration pending admin approval' });
    }

    // Same device
    if (existing_device === device_id) {
      return res.json({ status: existing_status || 'approved' });
    }

    // Different device — reject
    return res.status(403).json({ status: 'rejected', error: 'This account is bound to a different device. Contact admin.' });

  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /:id/device  — get device binding info (admin)
router.get('/:id/device', requireAdmin, (req, res) => {
  try {
    const w = db.prepare('SELECT id,name,device_id,device_status,device_registered_at FROM workers WHERE id=?').get(+req.params.id);
    if (!w) return res.status(404).json({ error: 'Not found' });
    res.json({ device_id: w.device_id, status: w.device_status, registered_at: w.device_registered_at });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /:id/device/approve  — admin approves device
router.post('/:id/device/approve', requireAdmin, (req, res) => {
  try {
    db.prepare('UPDATE workers SET device_status=? WHERE id=?').run('approved', +req.params.id);
    res.json({ ok: true, status: 'approved' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /:id/device/reset  — admin resets device (allows re-registration)
router.post('/:id/device/reset', requireAdmin, (req, res) => {
  try {
    db.prepare('UPDATE workers SET device_id=NULL, device_status=NULL, device_registered_at=NULL WHERE id=?').run(+req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
