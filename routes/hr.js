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
  try { db.prepare('ALTER TABLE work_schedule ADD COLUMN punch_out_grace_mins INTEGER DEFAULT 15').run(); } catch(e) {}
  // Annual vacation entitlement (default 14 days/year → ~1.167/mo accrual).
  // This supersedes the legacy vacation_accrual column (which stored the monthly rate).
  try { db.prepare('ALTER TABLE work_schedule ADD COLUMN annual_vacation_days REAL DEFAULT 14').run(); } catch(e) {}
  try {
    // Backfill annual_vacation_days from legacy vacation_accrual (monthly × 12)
    const row = db.prepare('SELECT annual_vacation_days, vacation_accrual FROM work_schedule LIMIT 1').get();
    if (row && (!row.annual_vacation_days || +row.annual_vacation_days === 0) && row.vacation_accrual) {
      const annual = +row.vacation_accrual * 12;
      db.prepare('UPDATE work_schedule SET annual_vacation_days=? WHERE id=1').run(Math.round(annual * 100) / 100);
    }
  } catch(e) {}
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
  // is_paid flag on leave_types — paid leave pays 100% + deducts from balance
  try { db.prepare('ALTER TABLE leave_types ADD COLUMN is_paid INTEGER DEFAULT 1').run(); } catch(e) {}
  try {
    // Unpaid leave shouldn't be paid
    db.prepare("UPDATE leave_types SET is_paid=0 WHERE lower(label) LIKE '%unpaid%' AND is_paid IS NULL").run();
    db.prepare("UPDATE leave_types SET is_paid=1 WHERE is_paid IS NULL").run();
  } catch(e) {}
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

  // ── One-time migration: drop the legacy CHECK(type IN ...) constraint.
  // The original table limited `type` to 4 hard-coded strings, but the app
  // now stores admin-defined labels from the leave_types table (e.g. "Hourly
  // Leave", "Injury Leave"). SQLite can't ALTER a constraint, so we rebuild.
  try {
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='leave_requests'").get();
    if (sql && sql.sql && sql.sql.indexOf("type IN ('vacation','sick','emergency','unpaid')") !== -1) {
      console.log('[hr init] Migrating leave_requests to drop legacy CHECK constraint...');
      db.exec('BEGIN');
      try {
        // 1. Get column list of the old table so we copy only existing columns
        const cols = db.prepare("PRAGMA table_info(leave_requests)").all().map(c => c.name);
        const colList = cols.join(',');
        // 2. Create new table with the same columns but NO check on type
        db.prepare(`CREATE TABLE leave_requests_new (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          worker_id      INTEGER NOT NULL,
          worker_name    TEXT NOT NULL,
          date_from      TEXT NOT NULL,
          date_to        TEXT NOT NULL,
          days           INTEGER NOT NULL,
          type           TEXT DEFAULT 'vacation',
          reason         TEXT,
          status         TEXT DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
          reviewed_by    TEXT,
          reviewed_at    DATETIME,
          attendance_id  INTEGER,
          medical_report TEXT,
          time_from      TEXT,
          time_to        TEXT,
          leave_kind     TEXT DEFAULT 'vacation',
          hours          REAL DEFAULT 0,
          notes          TEXT,
          created_at     DATETIME DEFAULT (datetime('now','localtime'))
        )`).run();
        // 3. Copy rows (only columns that exist in both)
        const newCols = db.prepare("PRAGMA table_info(leave_requests_new)").all().map(c => c.name);
        const shared = cols.filter(c => newCols.includes(c)).join(',');
        db.prepare(`INSERT INTO leave_requests_new (${shared}) SELECT ${shared} FROM leave_requests`).run();
        // 4. Swap
        db.prepare('DROP TABLE leave_requests').run();
        db.prepare('ALTER TABLE leave_requests_new RENAME TO leave_requests').run();
        db.exec('COMMIT');
        console.log('[hr init] Migration complete — leave_requests.type no longer restricted.');
      } catch(e) { db.exec('ROLLBACK'); throw e; }
    }
  } catch(e) { console.warn('[hr migrate leave_requests]', e.message); }

  // ── Payroll adjustments (admin-added manual line items) ──────────────────
  // Each adjustment has a date; it applies to the month containing that date.
  db.prepare(`CREATE TABLE IF NOT EXISTS payroll_adjustments (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    worker_id       INTEGER NOT NULL,
    worker_name     TEXT NOT NULL,
    adjustment_date TEXT NOT NULL,
    type            TEXT NOT NULL,
    amount          REAL NOT NULL,
    note            TEXT,
    created_by      TEXT,
    created_at      DATETIME DEFAULT (datetime('now','localtime'))
  )`).run();

  // ── Payroll runs (immutable history of closed months) ────────────────────
  db.prepare(`CREATE TABLE IF NOT EXISTS payroll_runs (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    worker_id               INTEGER NOT NULL,
    worker_name             TEXT NOT NULL,
    month                   TEXT NOT NULL,
    base_salary             REAL DEFAULT 0,
    ot_pay                  REAL DEFAULT 0,
    weekend_pay             REAL DEFAULT 0,
    holiday_pay             REAL DEFAULT 0,
    absence_deduction       REAL DEFAULT 0,
    lateness_deduction      REAL DEFAULT 0,
    balance_deduction       REAL DEFAULT 0,
    unpaid_leave_deduction  REAL DEFAULT 0,
    total_adjustments       REAL DEFAULT 0,
    gross_pay               REAL DEFAULT 0,
    ss_deduction            REAL DEFAULT 0,
    net_pay                 REAL DEFAULT 0,
    balance_before_close    REAL DEFAULT 0,
    closed_at               DATETIME,
    closed_by               TEXT,
    is_reopened             INTEGER DEFAULT 0,
    reopened_at             DATETIME,
    reopened_by             TEXT
  )`).run();
  // One active run per (worker, month) — reopened rows stay as history
  try { db.prepare('CREATE INDEX IF NOT EXISTS idx_payroll_runs_month ON payroll_runs(month, worker_id)').run(); } catch(e){}
} catch(e) { console.warn('[hr init]', e.message); }

// ──────────────────────────────────────────────────────────────────────────
// AUTO-ACCRUAL — adds monthly vacation accrual to each worker's balance.
// Runs on server startup and on month-close. Idempotent: uses last_accrued
// column to detect how many months have been missed and adds them all at
// once. If a worker has never had an accrual row (new hire), creates one
// with balance=0 and last_accrued=current month so they start accruing
// from NEXT month (opening balance is admin's responsibility to set).
// ──────────────────────────────────────────────────────────────────────────
function autoAccrueVacation() {
  try {
    const sched = db.prepare('SELECT annual_vacation_days, vacation_accrual FROM work_schedule ORDER BY id LIMIT 1').get();
    const annual = +sched?.annual_vacation_days || 14;
    // Monthly accrual = annual / 12. Fallback to legacy vacation_accrual for DBs not yet migrated.
    const accrual = annual > 0 ? (annual / 12) : (+sched?.vacation_accrual || 1.1667);
    const workers = db.prepare('SELECT id, name FROM workers WHERE is_active=1').all();
    const now = new Date();
    const thisMonth = now.toISOString().slice(0,7); // YYYY-MM
    let added = 0;
    for (const w of workers) {
      const vb = db.prepare('SELECT balance_days, last_accrued FROM vacation_balance WHERE worker_id=?').get(w.id);
      if (!vb) {
        // First time — create row at 0 balance, mark accrued-this-month so
        // first accrual hits NEXT month.
        db.prepare(`INSERT INTO vacation_balance (worker_id, worker_name, balance_days, accrual_rate, last_accrued, updated_at)
          VALUES (?, ?, 0, ?, ?, datetime('now','localtime'))`)
          .run(w.id, w.name, accrual, thisMonth);
        continue;
      }
      const lastAccruedMonth = vb.last_accrued ? vb.last_accrued.slice(0,7) : null;
      if (!lastAccruedMonth) {
        // Has a row but no last_accrued — mark this month so it starts cleanly next month
        db.prepare("UPDATE vacation_balance SET last_accrued=? WHERE worker_id=?")
          .run(thisMonth, w.id);
        continue;
      }
      // How many months between last_accrued and thisMonth?
      const [ly, lm] = lastAccruedMonth.split('-').map(Number);
      const [cy, cm] = thisMonth.split('-').map(Number);
      const monthsDiff = (cy - ly) * 12 + (cm - lm);
      if (monthsDiff > 0) {
        const addDays = monthsDiff * accrual;
        db.prepare(`UPDATE vacation_balance
          SET balance_days = COALESCE(balance_days,0) + ?,
              last_accrued = ?,
              updated_at = datetime('now','localtime')
          WHERE worker_id=?`)
          .run(addDays, thisMonth, w.id);
        added++;
        console.log(`[autoAccrue] ${w.name}: +${addDays.toFixed(3)} days (${monthsDiff} month(s) missed)`);
      }
    }
    if (added > 0) console.log(`[autoAccrue] Accrued ${added} worker(s) up to ${thisMonth}`);
  } catch(e) { console.warn('[autoAccrueVacation]', e.message); }
}

// Run on startup (once per process)
setTimeout(autoAccrueVacation, 500); // defer to let DB init fully

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
    const { label, requires_file, is_paid } = req.body;
    if (!label) return res.status(400).json({ error: 'label required' });
    const paid = is_paid === false || is_paid === 0 ? 0 : 1;
    const r = db.prepare('INSERT INTO leave_types (label,requires_file,is_system,active,is_paid) VALUES (?,?,0,1,?)')
      .run(label.trim(), requires_file ? 1 : 0, paid);
    res.status(201).json(db.prepare('SELECT * FROM leave_types WHERE id=?').get(r.lastInsertRowid));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/leave-types/:id', requireAdmin, (req, res) => {
  try {
    const lt = db.prepare('SELECT * FROM leave_types WHERE id=?').get(+req.params.id);
    if (!lt) return res.status(404).json({ error: 'Not found' });
    const { label, requires_file, is_paid } = req.body;
    const newLabel = label != null ? String(label).trim() : lt.label;
    const newReq   = requires_file != null ? (requires_file ? 1 : 0) : lt.requires_file;
    const newPaid  = is_paid != null ? ((is_paid === false || is_paid === 0) ? 0 : 1) : lt.is_paid;
    db.prepare('UPDATE leave_types SET label=?, requires_file=?, is_paid=? WHERE id=?')
      .run(newLabel, newReq, newPaid, +req.params.id);
    res.json(db.prepare('SELECT * FROM leave_types WHERE id=?').get(+req.params.id));
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
    const { start_time, end_time, thursday_end_time, break_mins, work_days, weekend_day, vacation_accrual, annual_vacation_days, punch_in_tolerance_mins, punch_out_grace_mins } = req.body;
    // annual_vacation_days is the new primary field; derive monthly rate for back-compat
    const annual = annual_vacation_days != null ? +annual_vacation_days : (+vacation_accrual * 12) || 14;
    const monthlyAccrual = annual / 12;
    db.prepare(`UPDATE work_schedule SET start_time=?,end_time=?,thursday_end_time=?,break_mins=?,work_days=?,weekend_day=?,vacation_accrual=?,annual_vacation_days=?,punch_in_tolerance_mins=?,punch_out_grace_mins=?,updated_at=datetime('now','localtime') WHERE id=1`)
      .run(start_time||'08:00', end_time||'16:30', thursday_end_time||'15:00', +break_mins||30, JSON.stringify(work_days||[]), weekend_day||'fri', monthlyAccrual, annual, +punch_in_tolerance_mins||10, +punch_out_grace_mins||15);
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
// ──────────────────────────────────────────────────────────────────────────
// PAYROLL v2 — monthly-fixed salary model
// ──────────────────────────────────────────────────────────────────────────
// Core principle: every worker has a fixed monthly base salary. Feb/Mar/Apr
// all pay the same base. Hourly rate is derived for OT and deductions only.
//
// Formula:
//   Gross = base + ot_pay + weekend_pay + holiday_pay + adjustments
//         − absence_deduction − lateness_deduction − balance_deduction
//         − unpaid_leave_deduction
//   Net   = Gross − ss_deduction
//
// Balance deduction = negative portion of (vacation_balance − paid_leave_used
//                     − lateness_in_days − absence_in_days) × hourly_rate
//
// Lateness: late_mins ÷ 480 = fractional days
// Absences: weekday with no punch-in AND no approved leave = 1 day
// Weekends and holidays are NEVER absences.
//
// Returns per-worker snapshot. If the month is closed (payroll_runs row with
// is_reopened=0 exists), returns the stored snapshot instead of recomputing.
router.get('/payroll', requireAdmin, (req, res) => {
  try {
    const { month } = req.query;
    const m = month || new Date().toISOString().slice(0,7);
    const sched = getSchedule();
    const STD_MINS = 8 * 60;
    const MONTHLY_DIVISOR_HOURS = 240; // 30 days × 8h fixed
    const accrual = +sched.annual_vacation_days > 0 ? (+sched.annual_vacation_days / 12) : (+sched.vacation_accrual || 1.1667);
    const weekendDay = {sun:0,mon:1,tue:2,wed:3,thu:4,fri:5,sat:6}[sched.weekend_day||'fri'] ?? 5;

    // Check if month is closed
    const closedRuns = db.prepare(
      "SELECT * FROM payroll_runs WHERE month=? AND is_reopened=0"
    ).all(m);
    const isClosed = closedRuns.length > 0;

    if (isClosed) {
      // Return the stored snapshot
      return res.json({
        month: m,
        schedule: sched,
        is_closed: true,
        closed_at: closedRuns[0].closed_at,
        closed_by: closedRuns[0].closed_by,
        workers: closedRuns.map(r => ({
          worker_id: r.worker_id,
          worker_name: r.worker_name,
          is_closed: true,
          // Snapshot fields
          base_salary:        +r.base_salary,
          overtime_pay:       +r.ot_pay,
          weekend_pay:        +r.weekend_pay,
          holiday_pay:        +r.holiday_pay,
          absence_deduction:  +r.absence_deduction,
          lateness_deduction: +r.lateness_deduction,
          balance_deduction:  +r.balance_deduction,
          unpaid_leave_deduction: +r.unpaid_leave_deduction,
          total_adjustments:  +r.total_adjustments,
          gross_pay:          +r.gross_pay,
          ss_deduction:       +r.ss_deduction,
          net_pay:            +r.net_pay,
          total_pay:          +r.net_pay,
          balance_before_close: +r.balance_before_close
        }))
      });
    }

    // OPEN month — compute live
    const workers = db.prepare('SELECT * FROM workers WHERE is_active=1 AND monthly_salary IS NOT NULL AND monthly_salary > 0').all();

    const results = workers.map(w => {
      const att = db.prepare(
        "SELECT * FROM attendance WHERE worker_id=? AND date LIKE ?"
      ).all(w.id, m+'%');

      const monthlyBase = +w.monthly_salary || 0;
      const hourlyRate  = monthlyBase > 0 ? (monthlyBase / MONTHLY_DIVISOR_HOURS) : (+w.hourly_rate || 0);

      // ── Attendance analysis ────────────────────────────────────────────
      let overtimeMins = 0, weekendMins = 0, holidayMins = 0;
      let unapprovedOtMins = 0, lateMins = 0;
      let daysWorked = 0;
      const workedDates = new Set();

      // Grace period mirrors attendance sweep — don't count minor punch-out drift as OT
      const graceMins = +sched.punch_out_grace_mins || 15;
      const shiftEndMain = sched.end_time || '16:30';
      const shiftEndThu  = sched.thursday_end_time || '15:00';

      att.forEach(a => {
        const worked = +a.total_mins || 0;
        const dt = (a.day_type || 'normal').toLowerCase();
        const otStatus = a.overtime_status || 'none';
        const otApproved = otStatus === 'approved';
        const otRejected = otStatus === 'rejected';
        const approvedOT = +a.overtime_mins || 0;
        if (a.punch_in) { daysWorked++; workedDates.add(a.date); lateMins += +a.late_mins || 0; }

        if (worked > 0) {
          if (dt === 'weekend') {
            if (otApproved)       weekendMins += approvedOT;
            else if (!otRejected) unapprovedOtMins += worked;
          } else if (dt === 'holiday') {
            if (otApproved)       holidayMins += approvedOT;
            else if (!otRejected) unapprovedOtMins += worked;
          } else {
            // Normal day — OT is determined by punch-out time vs shift end,
            // NOT by total_mins vs 8h (since total_mins is raw duration
            // including the unpaid break).
            if (a.punch_out && a.punch_in) {
              const dow = new Date(a.date).getDay();
              const shiftEnd = (dow === 4) ? shiftEndThu : shiftEndMain;
              const [eh, em] = shiftEnd.split(':').map(Number);
              const pout = String(a.punch_out);
              const poutTime = (pout.length >= 16 && (pout.charAt(10)===' '||pout.charAt(10)==='T')) ? pout.slice(11,16) : '';
              if (poutTime) {
                const [ph, pm] = poutTime.split(':').map(Number);
                const overMins = (ph*60+pm) - (eh*60+em);
                if (overMins > graceMins) {
                  if (otApproved)       overtimeMins += approvedOT;
                  else if (!otRejected) unapprovedOtMins += overMins;
                }
              }
            }
          }
        }
      });

      // ── Detect weekday absences in month ───────────────────────────────
      const [yy, mm] = m.split('-').map(Number);
      const daysInMonth = new Date(yy, mm, 0).getDate();
      const today = new Date();
      const endDay = (today.getFullYear() === yy && (today.getMonth()+1) === mm)
        ? today.getDate() : daysInMonth;
      let absenceDays = 0;
      for (let d = 1; d <= endDay; d++) {
        const dateStr = `${yy}-${String(mm).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
        const dow = new Date(dateStr).getDay();
        if (dow === weekendDay) continue; // weekends never absent
        if (workedDates.has(dateStr)) continue; // they showed up
        // Check if date is covered by approved leave (any type)
        const covered = db.prepare(`
          SELECT 1 FROM leave_requests
          WHERE worker_id=? AND status='approved'
            AND (
              (leave_kind='hourly' AND date_from=?)
              OR (leave_kind!='hourly' AND date_from<=? AND date_to>=?)
            )
          LIMIT 1
        `).get(w.id, dateStr, dateStr, dateStr);
        if (covered) continue;
        // Check if it's a holiday (we don't have a holidays table yet — treat 'holiday' attendance entries as holidays)
        // Skip dates with day_type='holiday' in any attendance row (even for other workers)
        const isHoliday = db.prepare(
          "SELECT 1 FROM attendance WHERE date=? AND day_type='holiday' LIMIT 1"
        ).get(dateStr);
        if (isHoliday) continue;
        absenceDays++;
      }

      // ── Paid / unpaid leave usage (approved, in month) ─────────────────
      const leaveRows = db.prepare(`
        SELECT lr.days, lr.hours, lr.leave_kind, COALESCE(lt.is_paid, 1) AS is_paid
        FROM leave_requests lr
        LEFT JOIN leave_types lt ON lower(trim(lt.label)) = lower(trim(lr.type))
        WHERE lr.worker_id = ?
          AND lr.status = 'approved'
          AND (
            (lr.leave_kind = 'hourly' AND lr.date_from LIKE ?) OR
            (lr.leave_kind != 'hourly' AND (lr.date_from LIKE ? OR lr.date_to LIKE ?))
          )
      `).all(w.id, m+'%', m+'%', m+'%');
      let paidLeaveDays = 0, unpaidLeaveMins = 0, paidLeaveMins = 0;
      leaveRows.forEach(lr => {
        const d = lr.leave_kind === 'hourly' ? (+lr.hours || 0) / 8 : (+lr.days || 0);
        if (lr.is_paid) { paidLeaveDays += d; paidLeaveMins += Math.round(d * STD_MINS); }
        else            unpaidLeaveMins += Math.round(d * STD_MINS);
      });
      const totalLeaveMins = paidLeaveMins + unpaidLeaveMins;

      // ── Balance math ────────────────────────────────────────────────────
      // Current balance before this month's deductions:
      const vb = db.prepare('SELECT balance_days FROM vacation_balance WHERE worker_id=?').get(w.id);
      const currentBalance = vb ? (+vb.balance_days || 0) : 0;
      const lateDays = lateMins / 480;
      // Effective balance after applying this month's deductions:
      const balanceAfter = currentBalance - paidLeaveDays - lateDays - absenceDays;
      const negativeDays = balanceAfter < 0 ? -balanceAfter : 0;
      const balanceDeduction = negativeDays * 8 * hourlyRate; // convert days to hours to cash

      // ── Pay computations ───────────────────────────────────────────────
      const overtimePay  = (overtimeMins / 60) * hourlyRate * 1.25;
      const weekendPay   = (weekendMins  / 60) * hourlyRate * 1.50;
      const holidayPay   = (holidayMins  / 60) * hourlyRate * 1.50;
      const absenceDeduction = absenceDays * 8 * hourlyRate; // legacy — the "balance_deduction" above already covers this
      const latenessDeduction = 0;                           // same — handled in balance
      const unpaidLeavePay     = (unpaidLeaveMins / 60) * hourlyRate; // cash out at 1.0× then deducted
      // Note: absences and lateness hit the vacation balance; the cash hit is only
      // when balance goes negative (covered by balanceDeduction).
      // So we do NOT double-deduct absences/lateness from cash.

      // ── Adjustments for this month ─────────────────────────────────────
      const adjRows = db.prepare(
        "SELECT id, type, amount, note, adjustment_date FROM payroll_adjustments WHERE worker_id=? AND adjustment_date LIKE ? ORDER BY adjustment_date"
      ).all(w.id, m+'%');
      const totalAdjustments = adjRows.reduce((s, a) => s + (+a.amount || 0), 0);

      // ── Gross / Net ────────────────────────────────────────────────────
      const gross = monthlyBase
                  + overtimePay + weekendPay + holidayPay
                  - balanceDeduction
                  - unpaidLeavePay
                  + totalAdjustments;
      const ssPct = +w.social_security_pct || 0;
      const ssDeduction = gross * (ssPct / 100);
      const net = gross - ssDeduction;

      return {
        worker_id: w.id, worker_name: w.name,
        employment_type: w.employment_type || 'hourly',
        hourly_rate: +hourlyRate.toFixed(4),
        monthly_salary: monthlyBase,
        is_closed: false,
        // Attendance analytics
        days_worked: daysWorked,
        absence_days: absenceDays,
        late_mins: lateMins,
        late_days: +lateDays.toFixed(3),
        // Balance
        balance_before: +currentBalance.toFixed(3),
        balance_after:  +balanceAfter.toFixed(3),
        paid_leave_days: +paidLeaveDays.toFixed(3),
        leave_hours:     +(totalLeaveMins / 60).toFixed(2),
        // Hour breakdown (OT only — base is not hours-based)
        overtime_hours: +(overtimeMins / 60).toFixed(2),
        weekend_hours:  +(weekendMins  / 60).toFixed(2),
        holiday_hours:  +(holidayMins  / 60).toFixed(2),
        unapproved_ot_hours: +(unapprovedOtMins / 60).toFixed(2),
        // Pay lines
        base_salary:        +monthlyBase.toFixed(2),
        overtime_pay:       +overtimePay.toFixed(2),
        weekend_pay:        +weekendPay.toFixed(2),
        holiday_pay:        +holidayPay.toFixed(2),
        balance_deduction:  +balanceDeduction.toFixed(2),
        unpaid_leave_deduction: +unpaidLeavePay.toFixed(2),
        total_adjustments:  +totalAdjustments.toFixed(2),
        adjustments:        adjRows,
        ss_pct:             ssPct,
        ss_deduction:       +ssDeduction.toFixed(2),
        gross_pay:          +gross.toFixed(2),
        net_pay:            +net.toFixed(2),
        total_pay:          +net.toFixed(2)
      };
    });
    res.json({ month: m, schedule: sched, is_closed: false, workers: results });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ──────────────────────────────────────────────────────────────────────────
// PAYROLL ADJUSTMENTS CRUD
// ──────────────────────────────────────────────────────────────────────────
router.get('/payroll/adjustments', requireAdmin, (req, res) => {
  try {
    const { worker_id, month, from, to } = req.query;
    let sql = 'SELECT * FROM payroll_adjustments WHERE 1=1';
    const p = [];
    if (worker_id) { sql += ' AND worker_id=?'; p.push(+worker_id); }
    if (month)     { sql += ' AND adjustment_date LIKE ?'; p.push(month+'%'); }
    if (from)      { sql += ' AND adjustment_date>=?'; p.push(from); }
    if (to)        { sql += ' AND adjustment_date<=?'; p.push(to); }
    sql += ' ORDER BY adjustment_date DESC, id DESC';
    res.json(db.prepare(sql).all(...p));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/payroll/adjustments', requireAdmin, (req, res) => {
  try {
    const { worker_id, adjustment_date, type, amount, note } = req.body;
    if (!worker_id || !adjustment_date || !type || amount === undefined)
      return res.status(400).json({ error: 'worker_id, adjustment_date, type, amount required' });
    const w = db.prepare('SELECT name FROM workers WHERE id=?').get(+worker_id);
    if (!w) return res.status(404).json({ error: 'Worker not found' });
    const allowedTypes = ['bonus','penalty','forgiveness','correction','other'];
    if (!allowedTypes.includes(type)) return res.status(400).json({ error: 'Invalid type' });
    // Prevent edits to a closed month
    const month = adjustment_date.slice(0,7);
    const locked = db.prepare("SELECT 1 FROM payroll_runs WHERE worker_id=? AND month=? AND is_reopened=0 LIMIT 1").get(+worker_id, month);
    if (locked) return res.status(400).json({ error: `${month} is closed. Reopen before editing.` });
    const r = db.prepare(`
      INSERT INTO payroll_adjustments (worker_id, worker_name, adjustment_date, type, amount, note, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(+worker_id, w.name, adjustment_date, type, +amount, note||null, req.user?.name || 'system');
    res.status(201).json(db.prepare('SELECT * FROM payroll_adjustments WHERE id=?').get(r.lastInsertRowid));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/payroll/adjustments/:id', requireAdmin, (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM payroll_adjustments WHERE id=?').get(+req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    const { adjustment_date, type, amount, note } = req.body;
    const newDate = adjustment_date || row.adjustment_date;
    // Prevent edits if locked
    const month = newDate.slice(0,7);
    const locked = db.prepare("SELECT 1 FROM payroll_runs WHERE worker_id=? AND month=? AND is_reopened=0 LIMIT 1").get(row.worker_id, month);
    if (locked) return res.status(400).json({ error: `${month} is closed. Reopen before editing.` });
    db.prepare(`
      UPDATE payroll_adjustments
      SET adjustment_date=?, type=?, amount=?, note=?
      WHERE id=?
    `).run(newDate, type||row.type, amount!==undefined?+amount:row.amount, note!==undefined?note:row.note, +req.params.id);
    res.json(db.prepare('SELECT * FROM payroll_adjustments WHERE id=?').get(+req.params.id));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/payroll/adjustments/:id', requireAdmin, (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM payroll_adjustments WHERE id=?').get(+req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    const month = row.adjustment_date.slice(0,7);
    const locked = db.prepare("SELECT 1 FROM payroll_runs WHERE worker_id=? AND month=? AND is_reopened=0 LIMIT 1").get(row.worker_id, month);
    if (locked) return res.status(400).json({ error: `${month} is closed. Reopen before deleting.` });
    db.prepare('DELETE FROM payroll_adjustments WHERE id=?').run(+req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ──────────────────────────────────────────────────────────────────────────
// MONTH CLOSE / REOPEN
// ──────────────────────────────────────────────────────────────────────────
router.post('/payroll/close-month', requireAdmin, (req, res) => {
  try {
    const { month } = req.body;
    if (!month || !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month YYYY-MM required' });
    // Prevent double-close
    const existing = db.prepare("SELECT COUNT(*) AS c FROM payroll_runs WHERE month=? AND is_reopened=0").get(month).c;
    if (existing > 0) return res.status(400).json({ error: `${month} is already closed. Reopen first if you need to recompute.` });

    // Re-fetch payroll by calling the GET handler logic inline.
    // To avoid an HTTP self-call, duplicate minimal logic here.
    const sched = getSchedule();
    const STD_MINS = 8 * 60;
    const MONTHLY_DIVISOR_HOURS = 240;
    const accrual = +sched.annual_vacation_days > 0 ? (+sched.annual_vacation_days / 12) : (+sched.vacation_accrual || 1.1667);
    const weekendDay = {sun:0,mon:1,tue:2,wed:3,thu:4,fri:5,sat:6}[sched.weekend_day||'fri'] ?? 5;
    const workers = db.prepare('SELECT * FROM workers WHERE is_active=1 AND monthly_salary IS NOT NULL AND monthly_salary > 0').all();

    const now = new Date().toISOString().replace('T',' ').slice(0,19);
    const by  = req.user?.name || 'system';
    const insertRun = db.prepare(`
      INSERT INTO payroll_runs (
        worker_id, worker_name, month,
        base_salary, ot_pay, weekend_pay, holiday_pay,
        absence_deduction, lateness_deduction, balance_deduction, unpaid_leave_deduction,
        total_adjustments, gross_pay, ss_deduction, net_pay,
        balance_before_close, closed_at, closed_by, is_reopened
      ) VALUES (?,?,?, ?,?,?,?, ?,?,?,?, ?,?,?,?, ?,?,?, 0)
    `);

    const tx = db.transaction(() => {
      workers.forEach(w => {
        // Compute per-worker payroll — same logic as GET /payroll
        const att = db.prepare("SELECT * FROM attendance WHERE worker_id=? AND date LIKE ?").all(w.id, month+'%');
        const monthlyBase = +w.monthly_salary || 0;
        const hourlyRate = monthlyBase > 0 ? (monthlyBase / MONTHLY_DIVISOR_HOURS) : (+w.hourly_rate || 0);
        let overtimeMins = 0, weekendMins = 0, holidayMins = 0, lateMins = 0;
        const workedDates = new Set();
        const graceMins = +sched.punch_out_grace_mins || 15;
        const shiftEndMain = sched.end_time || '16:30';
        const shiftEndThu  = sched.thursday_end_time || '15:00';
        att.forEach(a => {
          const worked = +a.total_mins || 0;
          const dt = (a.day_type || 'normal').toLowerCase();
          const otApproved = a.overtime_status === 'approved';
          const approvedOT = +a.overtime_mins || 0;
          if (a.punch_in) { workedDates.add(a.date); lateMins += +a.late_mins || 0; }
          if (worked > 0) {
            if (dt === 'weekend') { if (otApproved) weekendMins += approvedOT; }
            else if (dt === 'holiday') { if (otApproved) holidayMins += approvedOT; }
            else if (otApproved && a.punch_out && a.punch_in) {
              // Only count as normal-day OT if punch-out > shift end + grace
              const dow = new Date(a.date).getDay();
              const shiftEnd = (dow === 4) ? shiftEndThu : shiftEndMain;
              const [eh, em] = shiftEnd.split(':').map(Number);
              const pout = String(a.punch_out);
              const poutTime = (pout.length >= 16 && (pout.charAt(10)===' '||pout.charAt(10)==='T')) ? pout.slice(11,16) : '';
              if (poutTime) {
                const [ph, pm] = poutTime.split(':').map(Number);
                if ((ph*60+pm) - (eh*60+em) > graceMins) overtimeMins += approvedOT;
              }
            }
          }
        });
        // Absences
        const [yy, mm] = month.split('-').map(Number);
        const daysInMonth = new Date(yy, mm, 0).getDate();
        let absenceDays = 0;
        for (let d = 1; d <= daysInMonth; d++) {
          const dateStr = `${yy}-${String(mm).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
          const dow = new Date(dateStr).getDay();
          if (dow === weekendDay) continue;
          if (workedDates.has(dateStr)) continue;
          const covered = db.prepare(`SELECT 1 FROM leave_requests WHERE worker_id=? AND status='approved' AND ((leave_kind='hourly' AND date_from=?) OR (leave_kind!='hourly' AND date_from<=? AND date_to>=?)) LIMIT 1`).get(w.id, dateStr, dateStr, dateStr);
          if (covered) continue;
          const isHoliday = db.prepare("SELECT 1 FROM attendance WHERE date=? AND day_type='holiday' LIMIT 1").get(dateStr);
          if (isHoliday) continue;
          absenceDays++;
        }
        // Leaves
        const leaveRows = db.prepare(`
          SELECT lr.days, lr.hours, lr.leave_kind, COALESCE(lt.is_paid, 1) AS is_paid
          FROM leave_requests lr
          LEFT JOIN leave_types lt ON lower(trim(lt.label)) = lower(trim(lr.type))
          WHERE lr.worker_id = ? AND lr.status = 'approved'
            AND ((lr.leave_kind='hourly' AND lr.date_from LIKE ?) OR (lr.leave_kind!='hourly' AND (lr.date_from LIKE ? OR lr.date_to LIKE ?)))
        `).all(w.id, month+'%', month+'%', month+'%');
        let paidLeaveDays = 0, unpaidLeaveMins = 0;
        leaveRows.forEach(lr => {
          const d = lr.leave_kind === 'hourly' ? (+lr.hours || 0) / 8 : (+lr.days || 0);
          if (lr.is_paid) paidLeaveDays += d;
          else            unpaidLeaveMins += Math.round(d * STD_MINS);
        });
        // Balance
        const vb = db.prepare('SELECT balance_days FROM vacation_balance WHERE worker_id=?').get(w.id);
        const currentBalance = vb ? (+vb.balance_days || 0) : 0;
        const lateDays = lateMins / 480;
        const balanceAfter = currentBalance - paidLeaveDays - lateDays - absenceDays;
        const negativeDays = balanceAfter < 0 ? -balanceAfter : 0;
        const balanceDeduction = negativeDays * 8 * hourlyRate;
        // Pay
        const overtimePay = (overtimeMins / 60) * hourlyRate * 1.25;
        const weekendPay  = (weekendMins  / 60) * hourlyRate * 1.50;
        const holidayPay  = (holidayMins  / 60) * hourlyRate * 1.50;
        const unpaidLeavePay = (unpaidLeaveMins / 60) * hourlyRate;
        const adjSum = db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM payroll_adjustments WHERE worker_id=? AND adjustment_date LIKE ?").get(w.id, month+'%').s || 0;
        const gross = monthlyBase + overtimePay + weekendPay + holidayPay - balanceDeduction - unpaidLeavePay + adjSum;
        const ssPct = +w.social_security_pct || 0;
        const ssDeduction = gross * (ssPct / 100);
        const net = gross - ssDeduction;
        // Write run row
        insertRun.run(
          w.id, w.name, month,
          monthlyBase, overtimePay, weekendPay, holidayPay,
          0, 0, balanceDeduction, unpaidLeavePay,
          adjSum, gross, ssDeduction, net,
          currentBalance, now, by
        );
        // Reset balance to 0 + accrual
        db.prepare(`INSERT INTO vacation_balance (worker_id, worker_name, balance_days, accrual_rate, last_accrued, updated_at)
          VALUES (?, ?, ?, ?, ?, datetime('now','localtime'))
          ON CONFLICT(worker_id) DO UPDATE SET balance_days=excluded.balance_days, last_accrued=excluded.last_accrued, updated_at=excluded.updated_at`)
          .run(w.id, w.name, accrual, accrual, month+'-close');
      });
    });
    tx();
    res.json({ ok: true, month, closed_at: now, closed_by: by, worker_count: workers.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/payroll/reopen-month', requireAdmin, (req, res) => {
  try {
    const { month } = req.body;
    if (!month || !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month YYYY-MM required' });
    const runs = db.prepare("SELECT * FROM payroll_runs WHERE month=? AND is_reopened=0").all(month);
    if (!runs.length) return res.status(404).json({ error: `${month} is not closed.` });
    const now = new Date().toISOString().replace('T',' ').slice(0,19);
    const by  = req.user?.name || 'system';
    const tx = db.transaction(() => {
      runs.forEach(r => {
        // Restore each worker's balance
        db.prepare(`UPDATE vacation_balance SET balance_days=?, updated_at=datetime('now','localtime') WHERE worker_id=?`)
          .run(+r.balance_before_close, r.worker_id);
        // Mark run as reopened (keep as audit)
        db.prepare("UPDATE payroll_runs SET is_reopened=1, reopened_at=?, reopened_by=? WHERE id=?")
          .run(now, by, r.id);
      });
    });
    tx();
    res.json({ ok: true, month, reopened_at: now, reopened_by: by, worker_count: runs.length });
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
    // For each worker, compute days used from approved paid leaves
    // Vacation-kind: sum of (days) from approved paid-type leaves
    // Hourly-kind:   sum of (hours/8) from approved paid-type leaves
    const usedRows = db.prepare(`
      SELECT lr.worker_id,
        SUM(CASE
          WHEN lr.leave_kind='hourly' THEN COALESCE(lr.hours,0) / 8.0
          ELSE COALESCE(lr.days,0)
        END) AS used_days
      FROM leave_requests lr
      LEFT JOIN leave_types lt ON lower(trim(lt.label)) = lower(trim(lr.type))
      WHERE lr.status='approved'
        AND COALESCE(lt.is_paid, 1) = 1
      GROUP BY lr.worker_id
    `).all();
    const usedMap = Object.fromEntries(usedRows.map(r => [r.worker_id, +r.used_days || 0]));
    const result = allWorkers.map(w => {
      const b = rows.find(r => r.worker_id === w.id);
      const base = b ? (+b.balance_days || 0) : 0;
      const used = +usedMap[w.id] || 0;
      return {
        worker_id:    w.id,
        worker_name:  w.name,
        hire_date:    w.hire_date,
        entitlement_days: +base.toFixed(2),      // accrued total
        used_days:        +used.toFixed(2),       // deducted by approved paid leaves
        balance_days:     +(base - used).toFixed(2),  // effective remaining
        accrual_rate:     b ? (+b.accrual_rate || 1.167) : 1.167,
        last_accrued:     b ? b.last_accrued : null,
        updated_at:       b ? b.updated_at : null
      };
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
