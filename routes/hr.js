// routes/hr.js — HR: work schedule, overtime, leave requests
const router = require('express').Router();
const db     = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
router.use(requireAuth);

// ── Schema ────────────────────────────────────────────────────────────────
try {
  // Work schedule (global settings)
  db.prepare(`CREATE TABLE IF NOT EXISTS work_schedule (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    name              TEXT DEFAULT 'Default',
    start_time        TEXT DEFAULT '08:00',
    end_time          TEXT DEFAULT '16:30',
    thursday_end_time TEXT DEFAULT '15:00',
    break_mins        INTEGER DEFAULT 30,
    work_days         TEXT DEFAULT '["sun","mon","tue","wed","thu"]',
    weekend_day       TEXT DEFAULT 'fri',
    vacation_accrual  REAL DEFAULT 1.167,
    updated_at        DATETIME DEFAULT (datetime('now','localtime'))
  )`).run();
  // Seed default if empty
  const cnt = db.prepare('SELECT COUNT(*) AS c FROM work_schedule').get().c;
  if (!cnt) db.prepare(`INSERT INTO work_schedule (name,start_time,end_time,thursday_end_time,break_mins,work_days,weekend_day) VALUES ('Default','08:00','16:30','15:00',30,'["sun","mon","tue","wed","thu"]','fri')`).run();
  // Add new columns if missing
  ['thursday_end_time','weekend_day','vacation_accrual'].forEach(col => {
    try { db.prepare(`ALTER TABLE work_schedule ADD COLUMN ${col} TEXT`).run(); } catch(e) {}
  });
  // New tolerance columns
  try { db.prepare('ALTER TABLE work_schedule ADD COLUMN punch_in_tolerance_mins INTEGER DEFAULT 10').run(); } catch(e) {}
  try { db.prepare('ALTER TABLE work_schedule ADD COLUMN punch_out_grace_mins INTEGER DEFAULT 5').run(); } catch(e) {}
  // Leave request extra columns
  try { db.prepare('ALTER TABLE leave_requests ADD COLUMN medical_report TEXT').run(); } catch(e) {}
  // Ensure Hourly Leave system type exists
  try {
    const hlExists = db.prepare("SELECT id FROM leave_types WHERE label='Hourly Leave'").get();
    if(!hlExists) db.prepare("INSERT INTO leave_types (label,requires_file,is_system,active) VALUES ('Hourly Leave',0,1,1)").run();
  } catch(e) {}
  try { db.prepare('ALTER TABLE leave_requests ADD COLUMN time_from TEXT').run(); } catch(e) {}
  try { db.prepare('ALTER TABLE leave_requests ADD COLUMN time_to TEXT').run(); } catch(e) {}
  // Leave types table (admin-configurable)
  db.prepare(`CREATE TABLE IF NOT EXISTS leave_types (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    label      TEXT NOT NULL,
    requires_file INTEGER DEFAULT 0,
    is_system  INTEGER DEFAULT 0,
    active     INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT (datetime('now','localtime'))
  )`).run();
  // Seed system leave types
  const ltCount = db.prepare('SELECT COUNT(*) AS c FROM leave_types').get().c;
  if(!ltCount){
    const insLT = db.prepare('INSERT INTO leave_types (label,requires_file,is_system,active) VALUES (?,?,?,?)');
    insLT.run('Vacation', 0, 1, 1);
    insLT.run('Sick Leave', 1, 1, 1);
    insLT.run('Hourly Leave', 0, 1, 1);
    insLT.run('Injury Leave', 0, 0, 1);
    insLT.run('Unpaid Leave', 0, 0, 1);
  }
  // Leave request new columns
  try { db.prepare('ALTER TABLE leave_requests ADD COLUMN leave_kind TEXT DEFAULT "vacation"').run(); } catch(e) {}
  try { db.prepare('ALTER TABLE leave_requests ADD COLUMN hours REAL DEFAULT 0').run(); } catch(e) {}
  try { db.prepare('ALTER TABLE leave_requests ADD COLUMN notes TEXT').run(); } catch(e) {}
  // Attendance new columns
  try { db.prepare('ALTER TABLE attendance ADD COLUMN late_mins INTEGER DEFAULT 0').run(); } catch(e) {}
  try { db.prepare('ALTER TABLE attendance ADD COLUMN overtime_mins INTEGER DEFAULT 0').run(); } catch(e) {}
  try { db.prepare('ALTER TABLE attendance ADD COLUMN overtime_status TEXT DEFAULT "none"').run(); } catch(e) {}
  try { db.prepare('ALTER TABLE attendance ADD COLUMN overtime_notes TEXT').run(); } catch(e) {}
  try { db.prepare('ALTER TABLE attendance ADD COLUMN overtime_project TEXT').run(); } catch(e) {}

  // Vacation balance per worker
  db.prepare(`CREATE TABLE IF NOT EXISTS vacation_balance (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    worker_id       INTEGER NOT NULL UNIQUE,
    worker_name     TEXT NOT NULL,
    balance_days    REAL DEFAULT 0,
    accrual_rate    REAL DEFAULT 1.167,
    last_accrued    TEXT,
    updated_at      DATETIME DEFAULT (datetime('now','localtime'))
  )`).run();

  // Overtime requests
  db.prepare(`CREATE TABLE IF NOT EXISTS overtime (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    worker_id     INTEGER NOT NULL,
    worker_name   TEXT NOT NULL,
    date          TEXT NOT NULL,
    type          TEXT NOT NULL CHECK(type IN ('auto','manual')),
    start_time    TEXT,
    end_time      TEXT,
    mins          INTEGER,
    description   TEXT,
    status        TEXT DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
    reviewed_by   TEXT,
    reviewed_at   DATETIME,
    attendance_id INTEGER,
    created_at    DATETIME DEFAULT (datetime('now','localtime'))
  )`).run();

  // Leave requests
  db.prepare(`CREATE TABLE IF NOT EXISTS leave_requests (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    worker_id    INTEGER NOT NULL,
    worker_name  TEXT NOT NULL,
    date_from    TEXT NOT NULL,
    date_to      TEXT NOT NULL,
    days         INTEGER NOT NULL,
    type         TEXT DEFAULT 'vacation' CHECK(type IN ('vacation','sick','emergency','unpaid')),
    reason       TEXT,
    status       TEXT DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
    reviewed_by  TEXT,
    reviewed_at  DATETIME,
    created_at   DATETIME DEFAULT (datetime('now','localtime'))
  )`).run();
} catch(e) { console.warn('[hr init]', e.message); }

// ── Helpers ───────────────────────────────────────────────────────────────
function getSchedule() {
  const s = db.prepare('SELECT * FROM work_schedule ORDER BY id LIMIT 1').get();
  return { ...s, work_days: JSON.parse(s.work_days || '[]') };
}
function stdMinsForDate(sched, dateStr) {
  const day = new Date(dateStr).getDay(); // 0=Sun,4=Thu,5=Fri
  const weekend = sched.weekend_day || 'fri';
  const weekendDay = {sun:0,mon:1,tue:2,wed:3,thu:4,fri:5,sat:6}[weekend] ?? 5;
  if (day === weekendDay) return null; // weekend
  const endTime = (day === 4) ? (sched.thursday_end_time||'15:00') : (sched.end_time||'16:30');
  return timeDiffMins(sched.start_time, endTime) - (+sched.break_mins||30);
}
function nowStr() { return new Date().toISOString().replace('T',' ').slice(0,19); }
function todayStr() { return new Date().toISOString().slice(0,10); }
function timeDiffMins(t1, t2) {
  // t1, t2 as "HH:MM" or full datetime
  const parse = t => { const p=t.slice(-5).split(':'); return +p[0]*60+ +p[1]; };
  return parse(t2) - parse(t1);
}

// ══ LEAVE TYPES ═══════════════════════════════════════════════════════════
router.get('/leave-types', (req, res) => {
  try { res.json(db.prepare('SELECT * FROM leave_types WHERE active=1 ORDER BY is_system DESC, label').all()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/leave-types', requireAdmin, (req, res) => {
  try {
    const { label, requires_file } = req.body;
    if (!label) return res.status(400).json({ error: 'label required' });
    const r = db.prepare('INSERT INTO leave_types (label,requires_file,is_system,active) VALUES (?,?,0,1)')
      .run(label.trim(), requires_file ? 1 : 0);
    res.status(201).json(db.prepare('SELECT * FROM leave_types WHERE id=?').get(r.lastInsertRowid));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/leave-types/:id', requireAdmin, (req, res) => {
  try {
    const lt = db.prepare('SELECT * FROM leave_types WHERE id=?').get(+req.params.id);
    if (!lt) return res.status(404).json({ error: 'Not found' });
    if (lt.is_system) return res.status(400).json({ error: 'Cannot delete system leave types' });
    db.prepare('UPDATE leave_types SET active=0 WHERE id=?').run(+req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══ WORK SCHEDULE ══════════════════════════════════════════════════════════
router.get('/schedule', (req, res) => {
  try { res.json(getSchedule()); } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/schedule', requireAdmin, (req, res) => {
  try {
    const { start_time, end_time, thursday_end_time, break_mins, work_days, weekend_day, vacation_accrual, punch_in_tolerance_mins, punch_out_grace_mins } = req.body;
    db.prepare(`UPDATE work_schedule SET start_time=?,end_time=?,thursday_end_time=?,break_mins=?,work_days=?,weekend_day=?,vacation_accrual=?,punch_in_tolerance_mins=?,punch_out_grace_mins=?,updated_at=datetime('now','localtime') WHERE id=1`)
      .run(start_time||'08:00', end_time||'16:30', thursday_end_time||'15:00', +break_mins||30, JSON.stringify(work_days||[]), weekend_day||'fri', +vacation_accrual||1.167, +punch_in_tolerance_mins||10, +punch_out_grace_mins||5);
    res.json(getSchedule());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══ OVERTIME ═══════════════════════════════════════════════════════════════
router.get('/overtime', (req, res) => {
  try {
    const { status, worker_id, date_from, date_to } = req.query;
    let sql = 'SELECT * FROM overtime WHERE 1=1';
    const p = [];
    // Workers only see their own
    if (req.user.role !== 'admin') { sql += ' AND worker_id=?'; p.push(req.user.id); }
    else if (worker_id) { sql += ' AND worker_id=?'; p.push(+worker_id); }
    if (status)    { sql += ' AND status=?';    p.push(status); }
    if (date_from) { sql += ' AND date>=?';     p.push(date_from); }
    if (date_to)   { sql += ' AND date<=?';     p.push(date_to); }
    sql += ' ORDER BY date DESC, created_at DESC';
    res.json(db.prepare(sql).all(...p));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Worker submits manual overtime
router.post('/overtime', (req, res) => {
  try {
    const { date, start_time, end_time, description } = req.body;
    if (!date || !start_time || !end_time) return res.status(400).json({ error: 'date, start_time, end_time required' });
    const mins = timeDiffMins(start_time, end_time);
    if (mins <= 0) return res.status(400).json({ error: 'end_time must be after start_time' });
    const r = db.prepare(`INSERT INTO overtime (worker_id,worker_name,date,type,start_time,end_time,mins,description)
      VALUES (?,?,?,?,?,?,?,?)`).run(req.user.id, req.user.name, date, 'manual', start_time, end_time, mins, description||null);
    res.status(201).json(db.prepare('SELECT * FROM overtime WHERE id=?').get(r.lastInsertRowid));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Admin: approve/reject overtime
router.patch('/overtime/:id', requireAdmin, (req, res) => {
  try {
    const { status } = req.body;
    if (!['approved','rejected'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
    db.prepare(`UPDATE overtime SET status=?,reviewed_by=?,reviewed_at=datetime('now','localtime') WHERE id=?`)
      .run(status, req.user.name, +req.params.id);
    res.json(db.prepare('SELECT * FROM overtime WHERE id=?').get(+req.params.id));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══ AUTO OVERTIME (called by attendance route on punch-out) ════════════════
router.post('/overtime/auto', requireAuth, (req, res) => {
  try {
    const { date, punch_out, attendance_id } = req.body;
    const sched = getSchedule();
    const endTime = sched.end_time; // e.g. "16:30"
    const punchOutTime = punch_out.slice(11,16); // "HH:MM"
    const overMins = timeDiffMins(endTime, punchOutTime);
    if (overMins <= 0) return res.json({ overtime: false });
    // Check if auto overtime already recorded today
    const existing = db.prepare("SELECT id FROM overtime WHERE worker_id=? AND date=? AND type='auto'")
      .get(req.user.id, date);
    if (existing) return res.json({ overtime: false, message: 'Already recorded' });
    const r = db.prepare(`INSERT INTO overtime (worker_id,worker_name,date,type,start_time,end_time,mins,description,attendance_id)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(
      req.user.id, req.user.name, date, 'auto', endTime, punchOutTime, overMins,
      'Auto: worked beyond '+endTime, attendance_id||null);
    res.status(201).json({ overtime: true, record: db.prepare('SELECT * FROM overtime WHERE id=?').get(r.lastInsertRowid) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══ LEAVE REQUESTS ═════════════════════════════════════════════════════════
router.get('/leave', (req, res) => {
  try {
    const { status, worker_id } = req.query;
    let sql = 'SELECT * FROM leave_requests WHERE 1=1';
    const p = [];
    if (req.user.role !== 'admin') { sql += ' AND worker_id=?'; p.push(req.user.id); }
    else if (worker_id) { sql += ' AND worker_id=?'; p.push(+worker_id); }
    if (status) { sql += ' AND status=?'; p.push(status); }
    sql += ' ORDER BY created_at DESC';
    res.json(db.prepare(sql).all(...p));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/leave', (req, res) => {
  try {
    const { date_from, date_to, type, reason, leave_kind, hours, notes } = req.body;
    if (!date_from) return res.status(400).json({ error: 'date_from required' });
    const kind = leave_kind || 'vacation'; // 'vacation' or 'hourly'
    let days = 0;
    const hrs = +hours || 0;
    if (kind === 'hourly') {
      // Hourly leave: tracked in hours, date_from = date_to = the day
      days = 0; // no full days deducted directly
    } else {
      // Vacation: count calendar days (excluding friday)
      const sched = getSchedule();
      const weekendDay = {sun:0,mon:1,tue:2,wed:3,thu:4,fri:5,sat:6}[sched.weekend_day||'fri'] ?? 5;
      const d = new Date(date_from);
      const end = new Date(date_to || date_from);
      while (d <= end) { if (d.getDay() !== weekendDay) days++; d.setDate(d.getDate()+1); }
    }
    const { time_from, time_to, medical_report } = req.body;
    // For hourly: calculate hours from time_from/time_to if not provided
    let finalHrs = hrs;
    if (kind === 'hourly' && time_from && time_to && !hrs) {
      const [fh,fm] = time_from.split(':').map(Number);
      const [th,tm] = time_to.split(':').map(Number);
      finalHrs = Math.max(0, ((th*60+tm)-(fh*60+fm))/60);
    }
    const r = db.prepare(`INSERT INTO leave_requests (worker_id,worker_name,date_from,date_to,days,type,reason,leave_kind,hours,notes,time_from,time_to,medical_report)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        req.user.id, req.user.name, date_from, date_to||date_from,
        days, type||'vacation', reason||null, kind, finalHrs, notes||null,
        time_from||null, time_to||null, medical_report||null
      );
    res.status(201).json(db.prepare('SELECT * FROM leave_requests WHERE id=?').get(r.lastInsertRowid));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.patch('/leave/:id', requireAdmin, (req, res) => {
  try {
    const { status, date_from, date_to, leave_kind, hours, type, reason, notes } = req.body;
    const row = db.prepare('SELECT * FROM leave_requests WHERE id=?').get(+req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    // If editing fields (not just status)
    if (date_from || leave_kind || hours !== undefined) {
      const sched = getSchedule();
      const weekendDay = {sun:0,mon:1,tue:2,wed:3,thu:4,fri:5,sat:6}[sched.weekend_day||'fri'] ?? 5;
      const kind = leave_kind || row.leave_kind || 'vacation';
      const newFrom = date_from || row.date_from;
      const newTo   = date_to   || row.date_to;
      const hrs = hours !== undefined ? +hours : (row.hours||0);
      let days = row.days;
      if (kind === 'hourly') {
        days = 0;
      } else {
        days = 0;
        const d = new Date(newFrom); const end = new Date(newTo);
        while (d <= end) { if (d.getDay() !== weekendDay) days++; d.setDate(d.getDate()+1); }
      }
      db.prepare(`UPDATE leave_requests SET date_from=?,date_to=?,leave_kind=?,hours=?,days=?,type=?,reason=?,notes=? WHERE id=?`)
        .run(newFrom, newTo, kind, hrs, days, type||row.type, reason||row.reason, notes||row.notes, +req.params.id);
    }
    if (status && ['approved','rejected','pending'].includes(status)) {
      db.prepare(`UPDATE leave_requests SET status=?,reviewed_by=?,reviewed_at=datetime('now','localtime') WHERE id=?`)
        .run(status, req.user.name, +req.params.id);
    }
    res.json(db.prepare('SELECT * FROM leave_requests WHERE id=?').get(+req.params.id));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Admin: delete leave request
router.delete('/leave/:id', requireAdmin, (req, res) => {
  try {
    db.prepare('DELETE FROM leave_requests WHERE id=?').run(+req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══ PAYROLL (full calculation) ═════════════════════════════════════════════
router.get('/payroll', requireAdmin, (req, res) => {
  try {
    const { month } = req.query; // YYYY-MM
    const m = month || new Date().toISOString().slice(0,7);
    const sched = getSchedule();
    const stdMins = timeDiffMins(sched.start_time, sched.end_time) - (+sched.break_mins||30);
    const workers = db.prepare('SELECT * FROM workers WHERE is_active=1').all();
    const results = workers.map(w => {
      const att = db.prepare("SELECT * FROM attendance WHERE worker_id=? AND date LIKE ? AND punch_in IS NOT NULL")
        .all(w.id, m+'%');
      const ot = db.prepare("SELECT * FROM overtime WHERE worker_id=? AND date LIKE ? AND status='approved'")
        .all(w.id, m+'%');
      const lv = db.prepare("SELECT * FROM leave_requests WHERE worker_id=? AND date_from LIKE ? AND status='approved'")
        .all(w.id, m+'%');
      const hourlyRate = +w.hourly_rate || 0;
      let regularMins = 0, fridayMins = 0, lateMins = 0;
      att.forEach(a => {
        const worked = a.total_mins || 0;
        // Check if this date is a Friday (day 5)
        const dayOfWeek = new Date(a.date).getDay(); // 0=Sun,5=Fri
        if (dayOfWeek === 5) {
          fridayMins += worked; // Friday = +50%
        } else {
          regularMins += Math.min(worked, stdMins);
        }
        // Lateness: punch-in after schedule start (weekdays only)
        if (a.punch_in && dayOfWeek !== 5) {
          const punchInTime = a.punch_in.slice(11,16);
          const late = timeDiffMins(sched.start_time, punchInTime);
          if (late > 0) lateMins += late;
        }
      });
      const otMins = ot.reduce((a,o) => a+(o.mins||0), 0);
      const lvDays = lv.reduce((a,l) => a+(l.days||0), 0);
      const lvMins = lvDays * stdMins;
      const regularPay  = (regularMins/60) * hourlyRate;
      const fridayPay   = (fridayMins/60) * hourlyRate * 1.50;  // Friday +50%
      const otPay       = (otMins/60) * hourlyRate * 1.25;       // Overtime +25%
      const vacationPay = (lvMins/60) * hourlyRate * 1.50;       // Vacation +50%
      const grossPay    = regularPay + fridayPay + otPay + vacationPay;
      const ssPct       = +w.social_security_pct || 0;
      const ssDeduction = grossPay * (ssPct/100);
      const totalPay    = grossPay - ssDeduction;
      return {
        worker_id: w.id, worker_name: w.name,
        employment_type: w.employment_type||'hourly',
        hourly_rate: hourlyRate, monthly_salary: +w.monthly_salary||0,
        days_worked: att.length, late_mins: lateMins,
        regular_hours: +(regularMins/60).toFixed(2),
        friday_hours: +(fridayMins/60).toFixed(2),
        overtime_hours: +(otMins/60).toFixed(2),
        vacation_days: lvDays,
        regular_pay: +regularPay.toFixed(2),
        friday_pay: +fridayPay.toFixed(2),
        overtime_pay: +otPay.toFixed(2),
        vacation_pay: +vacationPay.toFixed(2),
        ss_pct: ssPct,
        ss_deduction: +ssDeduction.toFixed(2),
        gross_pay: +grossPay.toFixed(2),
        total_pay: w.employment_type==='monthly' ? +w.monthly_salary : +totalPay.toFixed(2)
      };
    });
    res.json({ month: m, schedule: sched, workers: results });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══ VACATION BALANCE ═══════════════════════════════════════════════════════
router.get('/vacation', requireAdmin, (req, res) => {
  try {
    const { worker_id } = req.query;
    let sql = `SELECT vb.*, w.hire_date FROM vacation_balance vb
      LEFT JOIN workers w ON w.id=vb.worker_id WHERE 1=1`;
    const p = [];
    if (worker_id) { sql += ' AND vb.worker_id=?'; p.push(+worker_id); }
    sql += ' ORDER BY vb.worker_name';
    const rows = db.prepare(sql).all(...p);
    // Also include workers with no balance record
    const allWorkers = db.prepare("SELECT id,name,hire_date FROM workers WHERE is_active=1").all();
    const result = allWorkers.map(w => {
      const b = rows.find(r => r.worker_id === w.id);
      return b || { worker_id: w.id, worker_name: w.name, balance_days: 0, accrual_rate: 1.167, hire_date: w.hire_date };
    });
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.patch('/vacation/:workerId', requireAdmin, (req, res) => {
  try {
    const { balance_days, accrual_rate } = req.body;
    const wid = +req.params.workerId;
    const worker = db.prepare('SELECT name FROM workers WHERE id=?').get(wid);
    if (!worker) return res.status(404).json({ error: 'Worker not found' });
    db.prepare(`INSERT INTO vacation_balance (worker_id,worker_name,balance_days,accrual_rate,updated_at)
      VALUES (?,?,?,?,datetime('now','localtime'))
      ON CONFLICT(worker_id) DO UPDATE SET balance_days=excluded.balance_days,
      accrual_rate=excluded.accrual_rate, updated_at=excluded.updated_at`)
      .run(wid, worker.name, +balance_days, +accrual_rate||1.167);
    res.json(db.prepare('SELECT * FROM vacation_balance WHERE worker_id=?').get(wid));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Accrue vacation for all active workers (call monthly)
router.post('/vacation/accrue', requireAdmin, (req, res) => {
  try {
    const sched = getSchedule();
    const rate = +sched.vacation_accrual || 1.167;
    const workers = db.prepare("SELECT id,name FROM workers WHERE is_active=1").all();
    const today = todayStr();
    workers.forEach(w => {
      db.prepare(`INSERT INTO vacation_balance (worker_id,worker_name,balance_days,accrual_rate,last_accrued,updated_at)
        VALUES (?,?,?,?,?,datetime('now','localtime'))
        ON CONFLICT(worker_id) DO UPDATE SET
          balance_days=balance_days+(SELECT COALESCE(accrual_rate,?) FROM vacation_balance WHERE worker_id=?),
          last_accrued=?,updated_at=datetime('now','localtime')`)
        .run(w.id, w.name, rate, rate, w.id, today);
    });
    res.json({ accrued: workers.length, rate, date: today });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
