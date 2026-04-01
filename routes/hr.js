// routes/hr.js — HR: work schedule, overtime, leave requests
const router = require('express').Router();
const db     = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
router.use(requireAuth);

// ── Schema ────────────────────────────────────────────────────────────────
try {
  // Work schedule (global settings)
  db.prepare(`CREATE TABLE IF NOT EXISTS work_schedule (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT DEFAULT 'Default',
    start_time  TEXT DEFAULT '08:00',
    end_time    TEXT DEFAULT '16:30',
    break_mins  INTEGER DEFAULT 30,
    work_days   TEXT DEFAULT '["mon","tue","wed","thu","fri"]',
    updated_at  DATETIME DEFAULT (datetime('now','localtime'))
  )`).run();
  // Seed default if empty
  const cnt = db.prepare('SELECT COUNT(*) AS c FROM work_schedule').get().c;
  if (!cnt) db.prepare(`INSERT INTO work_schedule (name) VALUES ('Default')`).run();

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
function nowStr() { return new Date().toISOString().replace('T',' ').slice(0,19); }
function todayStr() { return new Date().toISOString().slice(0,10); }
function timeDiffMins(t1, t2) {
  // t1, t2 as "HH:MM" or full datetime
  const parse = t => { const p=t.slice(-5).split(':'); return +p[0]*60+ +p[1]; };
  return parse(t2) - parse(t1);
}

// ══ WORK SCHEDULE ══════════════════════════════════════════════════════════
router.get('/schedule', (req, res) => {
  try { res.json(getSchedule()); } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/schedule', requireAdmin, (req, res) => {
  try {
    const { start_time, end_time, break_mins, work_days } = req.body;
    db.prepare(`UPDATE work_schedule SET start_time=?,end_time=?,break_mins=?,work_days=?,updated_at=datetime('now','localtime') WHERE id=1`)
      .run(start_time||'08:00', end_time||'16:30', +break_mins||30, JSON.stringify(work_days||[]));
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
    const { date_from, date_to, type, reason } = req.body;
    if (!date_from || !date_to) return res.status(400).json({ error: 'date_from and date_to required' });
    // Calculate business days
    let days = 0;
    const d = new Date(date_from);
    const end = new Date(date_to);
    while (d <= end) { const day = d.getDay(); if (day>0&&day<6) days++; d.setDate(d.getDate()+1); }
    const r = db.prepare(`INSERT INTO leave_requests (worker_id,worker_name,date_from,date_to,days,type,reason)
      VALUES (?,?,?,?,?,?,?)`).run(req.user.id, req.user.name, date_from, date_to, days, type||'vacation', reason||null);
    res.status(201).json(db.prepare('SELECT * FROM leave_requests WHERE id=?').get(r.lastInsertRowid));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.patch('/leave/:id', requireAdmin, (req, res) => {
  try {
    const { status } = req.body;
    if (!['approved','rejected'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
    db.prepare(`UPDATE leave_requests SET status=?,reviewed_by=?,reviewed_at=datetime('now','localtime') WHERE id=?`)
      .run(status, req.user.name, +req.params.id);
    res.json(db.prepare('SELECT * FROM leave_requests WHERE id=?').get(+req.params.id));
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

module.exports = router;
