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

  // ── Adjustment Types ─────────────────────────────────────────────────────
  db.prepare(`CREATE TABLE IF NOT EXISTS adjustment_types (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    direction   TEXT NOT NULL CHECK(direction IN ('addition','deduction')),
    title       TEXT NOT NULL,
    description TEXT,
    is_active   INTEGER DEFAULT 1,
    created_at  DATETIME DEFAULT (datetime('now','localtime'))
  )`).run();
  // Seed default types if empty
  const adjTypesCount = db.prepare('SELECT COUNT(*) AS c FROM adjustment_types').get().c;
  if (!adjTypesCount) {
    const ins = db.prepare("INSERT INTO adjustment_types (direction,title,description) VALUES (?,?,?)");
    ins.run('addition',  'Bonus',          'Performance or special reward bonus');
    ins.run('deduction', 'Salary Advance', 'Cash advance deducted from salary (سلفة)');
    ins.run('deduction', 'Penalty',        'Financial deduction for policy violation');
    ins.run('addition',  'Rounding',       'Auto salary rounding up to nearest JD');
  }
  // Ensure Rounding type exists
  const hasRounding = db.prepare("SELECT id FROM adjustment_types WHERE title='Rounding' LIMIT 1").get();
  if (!hasRounding) {
    db.prepare("INSERT INTO adjustment_types (direction,title,description) VALUES ('addition','Rounding','Auto salary rounding up to nearest JD')").run();
  }
  // Migrate payroll_adjustments — add new columns if missing
  ['adj_type_id INTEGER','description TEXT','payroll_month TEXT','worker_ids TEXT'].forEach(col => {
    try { db.prepare(`ALTER TABLE payroll_adjustments ADD COLUMN ${col}`).run(); } catch(e) {}
  });

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

// Ensure overtime edit tracking columns exist
try { db.prepare('ALTER TABLE overtime ADD COLUMN edited_by TEXT').run(); } catch(e) {}
try { db.prepare('ALTER TABLE overtime ADD COLUMN edited_at DATETIME').run(); } catch(e) {}

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
    const workers = db.prepare('SELECT id, name, join_date, vac_days_junior, vac_days_senior FROM workers WHERE is_active=1').all();
    const now = new Date();
    const thisMonth = now.toISOString().slice(0,7); // YYYY-MM
    let added = 0;
    for (const w of workers) {
      // Per-worker accrual rate based on seniority from join_date
      const junior = +w.vac_days_junior || 14;
      const senior = +w.vac_days_senior || 21;
      let accrual;
      if (w.join_date) {
        const yearsService = (now - new Date(w.join_date)) / (365.25 * 24 * 3600 * 1000);
        accrual = (yearsService >= 5 ? senior : junior) / 12;
      } else {
        accrual = junior / 12; // default junior if no join_date
      }
      const vb = db.prepare('SELECT balance_days, last_accrued FROM vacation_balance WHERE worker_id=?').get(w.id);
      if (!vb) {
        // First time — create row, accrue first month immediately since join_date is set
        db.prepare(`INSERT INTO vacation_balance (worker_id, worker_name, balance_days, accrual_rate, last_accrued, updated_at)
          VALUES (?, ?, ?, ?, ?, datetime('now','localtime'))`)
          .run(w.id, w.name, accrual, accrual, thisMonth);
        added++;
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
// Recompute the same-day OT conflict flag: 2+ live (non-rejected) rows => flag the live ones; otherwise clear all.
function syncConflictForDay(worker_id, date){
  try {
    const live = db.prepare("SELECT COUNT(*) c FROM overtime WHERE worker_id=? AND date=? AND status!='rejected'").get(worker_id, date).c;
    if (live >= 2) {
      db.prepare("UPDATE overtime SET conflict=1 WHERE worker_id=? AND date=? AND status!='rejected'").run(worker_id, date);
      db.prepare("UPDATE overtime SET conflict=0 WHERE worker_id=? AND date=? AND status='rejected'").run(worker_id, date);
    } else {
      db.prepare("UPDATE overtime SET conflict=0 WHERE worker_id=? AND date=?").run(worker_id, date);
    }
  } catch(e){ console.warn('[syncConflictForDay]', e.message); }
}

// vac carry-over (replay-based, deterministic): opening(M)=accrual(M)+max(endBal(M-1),0)
// replayed from join month; a negative month books its penalty and resets carry-in to 0.
function vacAccrualFor(w, m){
  const j=+w.vac_days_junior||14, s=+w.vac_days_senior||21;
  const jd=w.join_date?new Date(w.join_date):null;
  const p=m.split('-').map(Number), py=p[0], pm=p[1];
  const dim=new Date(py,pm,0).getDate();
  const mS=new Date(py,pm-1,1), mE=new Date(py,pm-1,dim);
  const yrs=jd?((mS-jd)/(365.25*24*3600*1000)):0;
  const full=(yrs>=5?s:j)/12;
  if(!jd) return full;
  if(jd>mE) return 0;
  if(jd<=mS) return full;
  return (full/dim)*(dim-jd.getDate()+1);
}
function vacMonthDeductions(w, m){
  const lr=db.prepare("SELECT lr.days,lr.hours,lr.leave_kind,COALESCE(lt.is_paid,1) AS is_paid FROM leave_requests lr LEFT JOIN leave_types lt ON lower(trim(lt.label))=lower(trim(lr.type)) WHERE lr.worker_id=? AND lr.status='approved' AND ((lr.leave_kind='hourly' AND lr.date_from LIKE ?) OR (lr.leave_kind!='hourly' AND (lr.date_from LIKE ? OR lr.date_to LIKE ?)))").all(w.id,m+'%',m+'%',m+'%');
  let paidLeave=0; lr.forEach(x=>{ const d=x.leave_kind==='hourly'?(+x.hours||0)/8:(+x.days||0); if(x.is_paid) paidLeave+=d; });
  const at=db.prepare("SELECT day_type,punch_in,late_mins FROM attendance WHERE worker_id=? AND date LIKE ?").all(w.id,m+'%');
  let lateM=0; at.forEach(a=>{ const dt=(a.day_type||'normal').toLowerCase(); if(a.punch_in&&dt==='normal') lateM+=+a.late_mins||0; });
  const sr=db.prepare('SELECT weekend_day FROM work_schedule ORDER BY id LIMIT 1').get()||{};
  const wknd=(sr.weekend_day!=null)?+sr.weekend_day:5;
  const p=m.split('-').map(Number), yy=p[0], mm=p[1];
  const dim=new Date(yy,mm,0).getDate();
  const worked=new Set(db.prepare("SELECT date FROM attendance WHERE worker_id=? AND date LIKE ? AND punch_in IS NOT NULL").all(w.id,m+'%').map(r=>r.date));
  let absence=0;
  for(let d=1; d<=dim; d++){
    const ds=yy+'-'+String(mm).padStart(2,'0')+'-'+String(d).padStart(2,'0');
    if(new Date(ds).getDay()===wknd) continue;
    if(worked.has(ds)) continue;
    if(db.prepare("SELECT 1 FROM leave_requests WHERE worker_id=? AND status='approved' AND ((leave_kind='hourly' AND date_from=?) OR (leave_kind!='hourly' AND date_from<=? AND date_to>=?)) LIMIT 1").get(w.id,ds,ds,ds)) continue;
    if(db.prepare("SELECT 1 FROM holidays WHERE date=? LIMIT 1").get(ds)) continue;
    absence++;
  }
  return { paidLeave, lateDays: lateM/480, absence };
}
function vacCarryIn(w, targetMonth){
  try{
    if(!w.join_date) return 0;
    const joinM=String(w.join_date).slice(0,7);
    if(joinM>=targetMonth) return 0;
    let carry=0;
    const c=joinM.split('-').map(Number); let cy=c[0], cm=c[1];
    const t=targetMonth.split('-').map(Number); const ty=t[0], tm=t[1];
    while(cy<ty || (cy===ty && cm<tm)){
      const m=cy+'-'+String(cm).padStart(2,'0');
      const dd=vacMonthDeductions(w,m);
      const endBal=(vacAccrualFor(w,m)+Math.max(carry,0))-dd.paidLeave-dd.lateDays-dd.absence;
      carry=endBal>0?endBal:0;
      cm++; if(cm>12){cm=1;cy++;}
    }
    return carry;
  }catch(e){ console.warn('[vacCarryIn]', e.message); return 0; }
}
function vacOpening(w, m){ return vacCarryIn(w, m) + vacAccrualFor(w, m); }

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
    if (!['approved','rejected','pending'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
    if (status === 'pending') {
      db.prepare("UPDATE overtime SET status='pending',reviewed_by=NULL,reviewed_at=NULL WHERE id=?").run(+req.params.id);
    } else {
      db.prepare(`UPDATE overtime SET status=?,reviewed_by=?,reviewed_at=datetime('now','localtime') WHERE id=?`)
        .run(status, req.user.name, +req.params.id);
    }
    // Sync status back to attendance record if linked
    const ot = db.prepare('SELECT * FROM overtime WHERE id=?').get(+req.params.id);
    if (ot && ot.attendance_id) {
      db.prepare('UPDATE attendance SET overtime_status=? WHERE id=?').run(status, ot.attendance_id);
    }
    if (ot) syncConflictForDay(ot.worker_id, ot.date);
    res.json(ot);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Admin: edit overtime entry
router.put('/overtime/:id', requireAdmin, (req, res) => {
  try {
    const { date, start_time, end_time, description, status } = req.body;
    if (!date || !start_time || !end_time) return res.status(400).json({ error: 'date, start_time, end_time required' });
    const mins = timeDiffMins(start_time, end_time);
    if (mins <= 0) return res.status(400).json({ error: 'end_time must be after start_time' });
    // Optional status change (approved/rejected/pending)
    const validStatus = ['approved','rejected','pending'].includes(status) ? status : null;
    if (validStatus) {
      db.prepare(`UPDATE overtime SET date=?,start_time=?,end_time=?,mins=?,description=?,status=?,
        reviewed_by=?,reviewed_at=datetime('now','localtime'),
        edited_by=?,edited_at=datetime('now','localtime') WHERE id=?`)
        .run(date, start_time, end_time, mins, description||null, validStatus, req.user.name, req.user.name, +req.params.id);
    } else {
      db.prepare(`UPDATE overtime SET date=?,start_time=?,end_time=?,mins=?,description=?,
        edited_by=?,edited_at=datetime('now','localtime') WHERE id=?`)
        .run(date, start_time, end_time, mins, description||null, req.user.name, +req.params.id);
    }
    // Sync back to attendance if linked
    const ot = db.prepare('SELECT * FROM overtime WHERE id=?').get(+req.params.id);
    if (ot && ot.attendance_id) {
      const attMins = (ot.status === 'rejected') ? 0 : mins;
      db.prepare('UPDATE attendance SET overtime_mins=?, overtime_status=? WHERE id=?')
        .run(attMins, ot.status, ot.attendance_id);
    }
    if (ot) syncConflictForDay(ot.worker_id, ot.date);
    res.json(db.prepare('SELECT * FROM overtime WHERE id=?').get(+req.params.id));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══ AUTO OVERTIME (called by attendance route on punch-out) ════════════════
// GET /overtime/mine — worker's own OT submissions
// Admin: delete a manual overtime row (auto rows are punch-derived - reject them instead)
router.delete('/overtime/:id', requireAdmin, (req, res) => {
  try {
    const ot = db.prepare('SELECT * FROM overtime WHERE id=?').get(+req.params.id);
    if (!ot) return res.status(404).json({ error: 'Not found' });
    if (ot.type === 'auto' && ot.attendance_id)
      return res.status(409).json({ error: 'Auto overtime is punch-derived - reject it instead (it would be recreated).' });
    db.prepare('DELETE FROM overtime WHERE id=?').run(ot.id);
    syncConflictForDay(ot.worker_id, ot.date);
    res.json({ ok: true, deleted: ot.id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/overtime/mine', requireAuth, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT id, date, type, start_time, end_time, mins, description,
             status, reviewed_by, reviewed_at, created_at
      FROM overtime
      WHERE worker_id = ?
      ORDER BY date DESC, id DESC
      LIMIT 30
    `).all(req.user.id);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

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
    const { date_from, date_to, type, reason, leave_kind, hours, notes, worker_id } = req.body;
    if (!date_from) return res.status(400).json({ error: 'date_from required' });
    // Admin can submit on behalf of a worker
    let targetWorker = { id: req.user.id, name: req.user.name };
    if (req.user.role === 'admin' && worker_id) {
      const w = db.prepare('SELECT id, name FROM workers WHERE id=?').get(+worker_id);
      if (w) targetWorker = w;
    }
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
        targetWorker.id, targetWorker.name, date_from, date_to||date_from,
        days, type||'vacation', reason||null, kind, finalHrs, notes||null,
        time_from||null, time_to||null, medical_report||null
      );
    res.status(201).json(db.prepare('SELECT * FROM leave_requests WHERE id=?').get(r.lastInsertRowid));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/leave/:id', requireAdmin, (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM leave_requests WHERE id=?').get(+req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    db.prepare('DELETE FROM leave_requests WHERE id=?').run(+req.params.id);
    res.json({ ok: true });
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

    // OPEN month — include all active workers with a salary rate set
    const workers = db.prepare('SELECT * FROM workers WHERE is_active=1 AND (hourly_rate > 0 OR (monthly_salary IS NOT NULL AND monthly_salary > 0)) ORDER BY name').all();

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

      const breakMins = +sched.break_mins || 30;
      att.forEach(a => {
        const worked = +a.total_mins || 0;
        const dt = (a.day_type || 'normal').toLowerCase();
        if (a.punch_in) {
          workedDates.add(a.date);
          if (dt === 'normal') { lateMins += +a.late_mins || 0; daysWorked++; } // base + lateness on normal days only; holiday/weekend never carry a lateness hit
        }
        if (worked > 0) {
          // Weekend/holiday: whole worked day (minus break if >5h) at +50%. NOT overtime.
          const netWorked = worked - (worked > 300 ? breakMins : 0);
          if (dt === 'weekend')      weekendMins += netWorked;
          else if (dt === 'holiday') holidayMins += netWorked;
          // Normal-day OT is sourced from the unified overtime table (below).
        }
      });

      // ── Overtime (normal days only) — from the unified overtime table ────
      // Approved auto+manual minutes are paid at +25%. Conflict-flagged or
      // pending records are NOT paid; they surface as "unapproved" for review.
      const otRows = db.prepare(`
        SELECT o.mins, o.status, o.conflict, a.day_type AS att_day_type
        FROM overtime o
        LEFT JOIN attendance a ON a.id = o.attendance_id
        WHERE o.worker_id = ? AND o.date LIKE ?
      `).all(w.id, m + '%');
      otRows.forEach(o => {
        const dt = (o.att_day_type || 'normal').toLowerCase();
        if (dt === 'weekend' || dt === 'holiday') return; // weekend/holiday is not OT
        const mins = +o.mins || 0;
        if (o.status === 'rejected') return; // rejected never counts (even with a stale conflict flag)
        if (o.conflict) { unapprovedOtMins += mins; return; } // unresolved conflict → not paid
        if (o.status === 'approved')     overtimeMins += mins;
        else if (o.status === 'pending') unapprovedOtMins += mins;
        // rejected → ignored
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
        // Check if date is a public holiday in the holidays table
        const isHoliday = db.prepare(
          "SELECT 1 FROM holidays WHERE date=? LIMIT 1"
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
      let vacationDays = 0; // whole-day vacation leaves only (not hourly)
      leaveRows.forEach(lr => {
        const d = lr.leave_kind === 'hourly' ? (+lr.hours || 0) / 8 : (+lr.days || 0);
        if (lr.is_paid) {
          paidLeaveDays += d;
          paidLeaveMins += Math.round(d * STD_MINS);
          // Count as vacation days only if it's a whole-day leave (not hourly)
          if (lr.leave_kind !== 'hourly') vacationDays += d;
        } else {
          unpaidLeaveMins += Math.round(d * STD_MINS);
        }
      });
      const totalLeaveMins = paidLeaveMins + unpaidLeaveMins;

      // ── Balance math ────────────────────────────────────────────────────
      // Opening balance = stored balance + this month's accrual (prorated for new joiners)
      const vb = db.prepare('SELECT balance_days FROM vacation_balance WHERE worker_id=?').get(w.id);
      const storedBalance = vb ? (+vb.balance_days || 0) : 0;
      // Per-worker accrual for this month
      const wJunior2 = +w.vac_days_junior || 14;
      const wSenior2 = +w.vac_days_senior || 21;
      const wJoinDate = w.join_date ? new Date(w.join_date) : null;
      const [pmY, pmM] = m.split('-').map(Number);
      const daysInPayMonth = new Date(pmY, pmM, 0).getDate();
      const monthStartDate = new Date(pmY, pmM-1, 1);
      const monthEndDate   = new Date(pmY, pmM-1, daysInPayMonth);
      const wYrs2 = wJoinDate ? ((monthStartDate - wJoinDate)/(365.25*24*3600*1000)) : 0;
      const wAnnual2 = wYrs2 >= 5 ? wSenior2 : wJunior2;
      const wFullAccrual = wAnnual2 / 12;
      let wMonthAccrual = 0;
      if (wJoinDate) {
        if (wJoinDate > monthEndDate)        wMonthAccrual = 0;
        else if (wJoinDate <= monthStartDate) wMonthAccrual = wFullAccrual;
        else {
          const dw = daysInPayMonth - wJoinDate.getDate() + 1;
          wMonthAccrual = (wFullAccrual / daysInPayMonth) * dw;
        }
      } else { wMonthAccrual = wFullAccrual; }
      const openingBalance = vacCarryIn(w, m) + wMonthAccrual;
      const lateDays = lateMins / 480;
      // End-of-month balance = opening - vacations - leaves - late - absences
      const balanceAfter = openingBalance - paidLeaveDays - lateDays - absenceDays;
      const negativeDays = balanceAfter < 0 ? -balanceAfter : 0;
      const balanceDeduction = negativeDays * 8 * hourlyRate;

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
        "SELECT id, type, adj_type_id, amount, note, description, adjustment_date, payroll_month FROM payroll_adjustments WHERE worker_id=? AND (payroll_month=? OR (payroll_month IS NULL AND adjustment_date LIKE ?)) ORDER BY adjustment_date"
      ).all(w.id, m, m+'%');
      const totalAdjustments = adjRows.reduce((s, a) => s + (+a.amount || 0), 0);
      const adjAddition  = adjRows.filter(a => (+a.amount||0) > 0).reduce((s,a) => s + (+a.amount||0), 0);
      const adjDeduction = adjRows.filter(a => (+a.amount||0) < 0).reduce((s,a) => s - (+a.amount||0), 0);
      // Split deductions: advances vs other
      const isAdvance = r => {
        const t = (r.type||'').toLowerCase();
        return t.includes('advance') || t.includes('سلفة') || t.includes('salary advance');
      };
      const adjAdvances  = adjRows.filter(a => (+a.amount||0) < 0 && isAdvance(a)).reduce((s,a) => s - (+a.amount||0), 0);
      const adjOtherDed  = adjRows.filter(a => (+a.amount||0) < 0 && !isAdvance(a)).reduce((s,a) => s - (+a.amount||0), 0);

      // ── Gross / Net ────────────────────────────────────────────────────
      // For hourly workers: base = daysWorked × 8h × hourlyRate
      const basePay = monthlyBase > 0 ? monthlyBase : (daysWorked * 8 * hourlyRate);
      const gross = basePay
                  + overtimePay + weekendPay + holidayPay
                  - balanceDeduction
                  - unpaidLeavePay
                  + totalAdjustments;
      const ssPct = +w.social_security_pct || 0;
      const ssDeduction = basePay * (ssPct / 100); // SS applied on base salary only
      const netBeforeRounding = gross - ssDeduction;
      // Auto-round to nearest 0.5 JD
      const netCeiled  = Math.round(netBeforeRounding * 2) / 2;
      const roundingDiff = Math.round((netCeiled - netBeforeRounding) * 100) / 100;
      const net = netCeiled;
      // Auto-create rounding adjustment if diff > 0 and not already done this month
      if (roundingDiff > 0) {
        const roundType = db.prepare("SELECT id FROM adjustment_types WHERE title='Rounding' LIMIT 1").get();
        const roundTypeId = roundType ? roundType.id : null;
        const existingRound = db.prepare(
          "SELECT id FROM payroll_adjustments WHERE worker_id=? AND payroll_month=? AND type='Rounding' LIMIT 1"
        ).get(w.id, m);
        if (!existingRound) {
          db.prepare(`INSERT INTO payroll_adjustments
            (worker_id,worker_name,adjustment_date,type,adj_type_id,amount,description,note,payroll_month,created_by)
            VALUES (?,?,?,?,?,?,?,?,?,?)`)
            .run(w.id, w.name, new Date().toISOString().slice(0,10), 'Rounding', roundTypeId,
                 roundingDiff, 'Auto rounding to nearest JD', null, m, 'system');
        }
      }

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
        balance_before:  +storedBalance.toFixed(3),
        vac_accrual:     +wMonthAccrual.toFixed(4),
        opening_balance: +openingBalance.toFixed(3),
        balance_after:   +balanceAfter.toFixed(3),
        vac_days_taken:  +(vacationDays + absenceDays).toFixed(3), // vacation leaves + absences only
        late_days:       +lateDays.toFixed(3),
        paid_leave_days: +paidLeaveDays.toFixed(3),
        leave_hours:     +(totalLeaveMins / 60).toFixed(2),
        // Hour breakdown (OT only — base is not hours-based)
        overtime_hours: +(overtimeMins / 60).toFixed(2),
        weekend_hours:  +(weekendMins  / 60).toFixed(2),
        holiday_hours:  +(holidayMins  / 60).toFixed(2),
        unapproved_ot_hours: +(unapprovedOtMins / 60).toFixed(2),
        // Pay lines
        base_salary:        +basePay.toFixed(2),
        overtime_pay:       +overtimePay.toFixed(2),
        weekend_pay:        +weekendPay.toFixed(2),
        holiday_pay:        +holidayPay.toFixed(2),
        balance_deduction:  +balanceDeduction.toFixed(2),
        unpaid_leave_deduction: +unpaidLeavePay.toFixed(2),
        total_adjustments:  +totalAdjustments.toFixed(2),
        adj_addition:      +adjAddition.toFixed(2),
        adj_deduction:     +adjDeduction.toFixed(2),
        adj_advances:      +adjAdvances.toFixed(2),
        adj_other_ded:     +adjOtherDed.toFixed(2),
        adjustments:        adjRows,
        ss_pct:             ssPct,
        ss_deduction:       +ssDeduction.toFixed(2),
        gross_pay:          +gross.toFixed(2),
        net_pay:            +net.toFixed(2),
        net_before_rounding: +netBeforeRounding.toFixed(2),
        rounding_diff:      +roundingDiff.toFixed(2),
        total_pay:          +net.toFixed(2)
      };
    });
    res.json({ month: m, schedule: sched, is_closed: false, workers: results });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ──────────────────────────────────────────────────────────────────────────
// PAYROLL ADJUSTMENTS CRUD
// ──────────────────────────────────────────────────────────────────────────
// ── Adjustment Types CRUD ─────────────────────────────────────────────────
router.get('/adjustment-types', requireAdmin, (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM adjustment_types ORDER BY direction, title').all();
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/adjustment-types', requireAdmin, (req, res) => {
  try {
    const { direction, title, description } = req.body;
    if (!direction || !title) return res.status(400).json({ error: 'direction and title required' });
    if (!['addition','deduction'].includes(direction)) return res.status(400).json({ error: 'direction must be addition or deduction' });
    const r = db.prepare('INSERT INTO adjustment_types (direction,title,description) VALUES (?,?,?)').run(direction, title.trim(), description||null);
    res.status(201).json(db.prepare('SELECT * FROM adjustment_types WHERE id=?').get(r.lastInsertRowid));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/adjustment-types/:id', requireAdmin, (req, res) => {
  try {
    const { direction, title, description, is_active } = req.body;
    if (!direction || !title) return res.status(400).json({ error: 'direction and title required' });
    db.prepare('UPDATE adjustment_types SET direction=?,title=?,description=?,is_active=? WHERE id=?')
      .run(direction, title.trim(), description||null, is_active===false?0:1, +req.params.id);
    res.json(db.prepare('SELECT * FROM adjustment_types WHERE id=?').get(+req.params.id));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/adjustment-types/:id', requireAdmin, (req, res) => {
  try {
    const used = db.prepare('SELECT COUNT(*) AS c FROM payroll_adjustments WHERE adj_type_id=?').get(+req.params.id);
    if (used.c > 0) return res.status(409).json({ error: 'Cannot delete — this type is used in '+used.c+' adjustment(s)' });
    db.prepare('DELETE FROM adjustment_types WHERE id=?').run(+req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Payroll Adjustments ───────────────────────────────────────────────────
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
    const { worker_ids, worker_id, adjustment_date, adj_type_id, amount, description, note, payroll_month } = req.body;
    const wids = (worker_ids && worker_ids.length) ? worker_ids.map(Number) : (worker_id ? [+worker_id] : []);
    if (!wids.length || !adjustment_date || amount === undefined)
      return res.status(400).json({ error: 'worker_id(s), adjustment_date, amount required' });
    // Get type info from adjustment_types
    let direction = 'addition', typeLabel = 'other';
    if (adj_type_id) {
      const at = db.prepare('SELECT * FROM adjustment_types WHERE id=?').get(+adj_type_id);
      if (at) { direction = at.direction; typeLabel = at.title; }
    }
    const signedAmount = direction === 'deduction' ? -Math.abs(+amount) : Math.abs(+amount);
    const month = payroll_month || adjustment_date.slice(0,7);
    const created = [];
    for (const wid of wids) {
      const w = db.prepare('SELECT name FROM workers WHERE id=?').get(+wid);
      if (!w) continue;
      const locked = db.prepare("SELECT 1 FROM payroll_runs WHERE worker_id=? AND month=? AND is_reopened=0 LIMIT 1").get(+wid, month);
      if (locked) continue; // skip locked months silently
      const r = db.prepare(`
        INSERT INTO payroll_adjustments (worker_id, worker_name, adjustment_date, type, adj_type_id, amount, description, note, payroll_month, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(+wid, w.name, adjustment_date, typeLabel, adj_type_id||null, signedAmount, description||null, note||null, month, req.user?.name||'system');
      created.push(db.prepare('SELECT * FROM payroll_adjustments WHERE id=?').get(r.lastInsertRowid));
    }
    res.status(201).json(created.length === 1 ? created[0] : created);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/payroll/adjustments/:id', requireAdmin, (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM payroll_adjustments WHERE id=?').get(+req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    const { adjustment_date, type, adj_type_id, amount, description, note, payroll_month } = req.body;
    const newDate = adjustment_date || row.adjustment_date;
    // Prevent edits if locked
    const month = newDate.slice(0,7);
    const locked = db.prepare("SELECT 1 FROM payroll_runs WHERE worker_id=? AND month=? AND is_reopened=0 LIMIT 1").get(row.worker_id, month);
    if (locked) return res.status(400).json({ error: `${month} is closed. Reopen before editing.` });
    // Get direction from adj_type if provided
    let typeLabel = type || row.type;
    let direction = 'addition';
    if (adj_type_id) {
      const at = db.prepare('SELECT * FROM adjustment_types WHERE id=?').get(+adj_type_id);
      if (at) { direction = at.direction; typeLabel = at.title; }
    }
    const signedAmount = amount !== undefined
      ? (direction === 'deduction' ? -Math.abs(+amount) : Math.abs(+amount))
      : row.amount;
    db.prepare(`
      UPDATE payroll_adjustments
      SET adjustment_date=?, type=?, adj_type_id=?, amount=?, description=?, note=?, payroll_month=?
      WHERE id=?
    `).run(
      newDate,
      typeLabel,
      adj_type_id || row.adj_type_id || null,
      signedAmount,
      description !== undefined ? description : row.description,
      note !== undefined ? note : row.note,
      payroll_month || row.payroll_month || newDate.slice(0,7),
      +req.params.id
    );
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
        let daysWorked = 0, unapprovedOtMins = 0;
        const workedDates = new Set();
        const breakMins = +sched.break_mins || 30;
        att.forEach(a => {
          const worked = +a.total_mins || 0;
          const dt = (a.day_type || 'normal').toLowerCase();
          if (a.punch_in) {
            workedDates.add(a.date);
            if (dt === 'normal') { lateMins += +a.late_mins || 0; daysWorked++; } // lateness on normal days only
          }
          if (worked > 0) {
            const netWorked = worked - (worked > 300 ? breakMins : 0);
            if (dt === 'weekend')      weekendMins += netWorked;
            else if (dt === 'holiday') holidayMins += netWorked;
          }
        });
        // Normal-day OT from the unified overtime table (approved auto+manual, conflict=0)
        const otRows = db.prepare(`
          SELECT o.mins, o.status, o.conflict, a.day_type AS att_day_type
          FROM overtime o
          LEFT JOIN attendance a ON a.id = o.attendance_id
          WHERE o.worker_id = ? AND o.date LIKE ?
        `).all(w.id, month + '%');
        otRows.forEach(o => {
          const dt = (o.att_day_type || 'normal').toLowerCase();
          if (dt === 'weekend' || dt === 'holiday') return;
          const mins = +o.mins || 0;
          if (o.status === 'rejected') return; // rejected never counts (even with a stale conflict flag)
          if (o.conflict) { unapprovedOtMins += mins; return; }
          if (o.status === 'approved')     overtimeMins += mins;
          else if (o.status === 'pending') unapprovedOtMins += mins;
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
          const isHoliday = db.prepare("SELECT 1 FROM holidays WHERE date=? LIMIT 1").get(dateStr);
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
        const currentBalance = vacOpening(w, month);
        const lateDays = lateMins / 480;
        const balanceAfter = currentBalance - paidLeaveDays - lateDays - absenceDays;
        const negativeDays = balanceAfter < 0 ? -balanceAfter : 0;
        const balanceDeduction = negativeDays * 8 * hourlyRate;
        // Pay
        const overtimePay = (overtimeMins / 60) * hourlyRate * 1.25;
        const weekendPay  = (weekendMins  / 60) * hourlyRate * 1.50;
        const holidayPay  = (holidayMins  / 60) * hourlyRate * 1.50;
        const unpaidLeavePay = (unpaidLeaveMins / 60) * hourlyRate;
        const adjSum = db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM payroll_adjustments WHERE worker_id=? AND (payroll_month=? OR (payroll_month IS NULL AND adjustment_date LIKE ?))").get(w.id, month, month+'%').s || 0;
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
        // Reset balance to 0 + per-worker accrual (based on seniority from join_date)
        const wJunior = +w.vac_days_junior || 14;
        const wSenior = +w.vac_days_senior || 21;
        const wYrs = w.join_date ? ((new Date() - new Date(w.join_date)) / (365.25*24*3600*1000)) : 0;
        const wAccrual = (wYrs >= 5 ? wSenior : wJunior) / 12;
        db.prepare(`INSERT INTO vacation_balance (worker_id, worker_name, balance_days, accrual_rate, last_accrued, updated_at)
          VALUES (?, ?, ?, ?, ?, datetime('now','localtime'))
          ON CONFLICT(worker_id) DO UPDATE SET balance_days=excluded.balance_days, accrual_rate=excluded.accrual_rate, last_accrued=excluded.last_accrued, updated_at=excluded.updated_at`)
          .run(w.id, w.name, (balanceAfter > 0 ? balanceAfter : 0), wAccrual, month+'-close');
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
    let sql = `SELECT vb.*, w.join_date AS hire_date FROM vacation_balance vb
      LEFT JOIN workers w ON w.id=vb.worker_id WHERE 1=1`;
    const p = [];
    if (worker_id) { sql += ' AND vb.worker_id=?'; p.push(+worker_id); }
    sql += ' ORDER BY vb.worker_name';
    const rows = db.prepare(sql).all(...p);
    // Also include workers with no balance record
    const allWorkers = db.prepare("SELECT id,name,join_date AS hire_date FROM workers WHERE is_active=1").all();
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

// ── Vacation Balance Report ───────────────────────────────────────────────
// GET /hr/vacation-report?from=YYYY-MM&to=YYYY-MM
// Returns pivoted data: per worker, per month — opening, vacations, leaves,
// late_days, absences, ending balance, cash deduction
router.get('/vacation-report', requireAdmin, (req, res) => {
  try {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ error: 'from and to (YYYY-MM) required' });

    // Build list of months between from and to
    const months = [];
    let [cy, cm] = from.split('-').map(Number);
    const [ey, em] = to.split('-').map(Number);
    while (cy < ey || (cy === ey && cm <= em)) {
      months.push(`${cy}-${String(cm).padStart(2,'0')}`);
      cm++; if (cm > 12) { cm = 1; cy++; }
    }

    const now = new Date();
    const workers = db.prepare('SELECT * FROM workers WHERE is_active=1 AND (hourly_rate > 0 OR (monthly_salary IS NOT NULL AND monthly_salary > 0)) ORDER BY name').all();
    const sched = getSchedule();
    const weekendDay = {sun:0,mon:1,tue:2,wed:3,thu:4,fri:5,sat:6}[sched.weekend_day||'fri'] ?? 5;

    const results = workers.map(w => {
      const junior = +w.vac_days_junior || 14;
      const senior = +w.vac_days_senior || 21;
      const hourlyRate = +w.hourly_rate || 0;
      const joinDate = w.join_date ? new Date(w.join_date) : null;

      // Start with balance from vacation_balance table as of the month before 'from'
      // We replay month by month from the beginning
      // Get the stored balance
      const vb = db.prepare('SELECT balance_days FROM vacation_balance WHERE worker_id=?').get(w.id);
      let runningBalance = vb ? +vb.balance_days : 0;

      // We need to compute from scratch for each month in range
      // For accuracy, we carry balance forward month by month
      const monthData = months.map(m => {
        const [yy, mm] = m.split('-').map(Number);
        const daysInMonth = new Date(yy, mm, 0).getDate();
        const monthStart = new Date(yy, mm-1, 1);
        const monthEnd   = new Date(yy, mm-1, daysInMonth);

        // Skip future months entirely
        if (monthStart > now) {
          return { month: m, future: true, accrual:0, opening:0, vac_days:0, leave_days:0, late_days:0, absence_days:0, total_deductions:0, ending:0, cash_deduction:0 };
        }
        // Skip months before worker joined
        if (joinDate && monthEnd < joinDate) {
          return { month: m, before_join: true, accrual:0, opening:0, vac_days:0, leave_days:0, late_days:0, absence_days:0, total_deductions:0, ending:0, cash_deduction:0 };
        }

        // ── Accrual for this month ─────────────────────────────────────
        const yearsService = joinDate
          ? ((monthStart - joinDate) / (365.25*24*3600*1000))
          : 0;
        const annualDays = yearsService >= 5 ? senior : junior;
        const fullMonthAccrual = annualDays / 12;

        let accrual = 0;
        if (joinDate) {
          if (joinDate > monthEnd) {
            accrual = 0; // not yet joined
          } else if (joinDate <= monthStart) {
            accrual = fullMonthAccrual; // full month
          } else {
            // Prorated: days from join date to end of month
            const daysWorked = daysInMonth - joinDate.getDate() + 1;
            accrual = (fullMonthAccrual / daysInMonth) * daysWorked;
          }
        } else {
          accrual = fullMonthAccrual;
        }
        accrual = Math.round(accrual * 10000) / 10000;

        // Opening balance = previous ending + this month's accrual
        const opening = Math.round((runningBalance + accrual) * 10000) / 10000;

        // ── Vacation days taken (approved vacation leaves) ─────────────
        const vacRows = db.prepare(`
          SELECT SUM(CASE WHEN leave_kind='hourly' THEN hours/8.0 ELSE days END) AS total
          FROM leave_requests lr
          LEFT JOIN leave_types lt ON lower(trim(lt.label))=lower(trim(lr.type))
          WHERE lr.worker_id=? AND lr.status='approved'
            AND lower(trim(lr.type)) IN ('vacation','annual leave','annual','إجازة سنوية')
            AND (date_from LIKE ? OR date_to LIKE ?)
        `).get(w.id, m+'%', m+'%');
        const vacLeaves = Math.round((+vacRows?.total || 0) * 10000) / 10000; // will add absenceDays after

        // ── Other approved hourly leaves (non-sick, non-vacation) ──────
        const leaveRows = db.prepare(`
          SELECT SUM(CASE WHEN leave_kind='hourly' THEN hours/8.0 ELSE days END) AS total
          FROM leave_requests lr
          LEFT JOIN leave_types lt ON lower(trim(lt.label))=lower(trim(lr.type))
          WHERE lr.worker_id=? AND lr.status='approved'
            AND lower(trim(lr.type)) NOT IN ('vacation','annual leave','annual','إجازة سنوية','sick','sick leave','مرضية')
            AND COALESCE(lt.is_paid,1)=1
            AND (date_from LIKE ? OR date_to LIKE ?)
        `).get(w.id, m+'%', m+'%');
        const leaveDays = Math.round((+leaveRows?.total || 0) * 10000) / 10000;

        // ── Late minutes → days ────────────────────────────────────────
        const lateRow = db.prepare(`
          SELECT SUM(late_mins) AS total FROM attendance
          WHERE worker_id=? AND date LIKE ? AND punch_in IS NOT NULL
        `).get(w.id, m+'%');
        const lateDays = Math.round(((+lateRow?.total || 0) / 480) * 10000) / 10000;

        // ── Absence days ───────────────────────────────────────────────
        let absenceDays = 0;
        const today2 = new Date();
        const endDay = (today2.getFullYear()===yy && (today2.getMonth()+1)===mm)
          ? today2.getDate() : daysInMonth;
        const workedDates = new Set(
          db.prepare(`SELECT date FROM attendance WHERE worker_id=? AND date LIKE ? AND punch_in IS NOT NULL`)
            .all(w.id, m+'%').map(r => r.date)
        );
        for (let d = 1; d <= endDay; d++) {
          const dateStr = `${yy}-${String(mm).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
          if (joinDate && new Date(dateStr) < joinDate) continue;
          const dow = new Date(dateStr).getDay();
          if (dow === weekendDay) continue;
          if (workedDates.has(dateStr)) continue;
          const covered = db.prepare(`SELECT 1 FROM leave_requests
            WHERE worker_id=? AND status='approved'
            AND ((leave_kind='hourly' AND date_from=?) OR (leave_kind!='hourly' AND date_from<=? AND date_to>=?))
            LIMIT 1`).get(w.id, dateStr, dateStr, dateStr);
          if (covered) continue;
          const isHol = db.prepare('SELECT 1 FROM holidays WHERE date=? LIMIT 1').get(dateStr);
          if (isHol) continue;
          absenceDays++;
        }

        // ── Combine vacation leaves + absences ────────────────────────
        const vacDays = Math.round((vacLeaves + absenceDays) * 10000) / 10000;

        // ── Ending balance ─────────────────────────────────────────────
        const totalDeductions = vacDays + leaveDays + lateDays;
        const ending = Math.round((opening - totalDeductions) * 10000) / 10000;

        // ── Cash deduction if negative ─────────────────────────────────
        const cashDeduction = ending < 0
          ? Math.round(Math.abs(ending) * 8 * hourlyRate * 100) / 100
          : 0;

        // Carry forward — if negative, reset to 0 (cash deduction applied)
        runningBalance = ending < 0 ? 0 : ending;

        return {
          month: m,
          accrual:       +accrual.toFixed(4),
          opening:       +opening.toFixed(4),
          vac_days:      +vacDays.toFixed(2),
          leave_days:    +leaveDays.toFixed(2),
          late_days:     +lateDays.toFixed(3),
          absence_days:  absenceDays,
          total_deductions: +totalDeductions.toFixed(3),
          ending:        +ending.toFixed(4),
          cash_deduction: +cashDeduction.toFixed(2)
        };
      });

      return {
        worker_id:   w.id,
        worker_name: w.name,
        join_date:   w.join_date,
        hourly_rate: hourlyRate,
        months:      monthData
      };
    });

    res.json({ months, workers: results });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Worker Detail Report ─────────────────────────────────────────────────
// GET /hr/worker-detail?worker_id=X&month=YYYY-MM
router.get('/worker-detail', requireAdmin, (req, res) => {
  try {
    const { worker_id, month } = req.query;
    if (!worker_id || !month) return res.status(400).json({ error: 'worker_id and month required' });
    const w = db.prepare('SELECT * FROM workers WHERE id=?').get(+worker_id);
    if (!w) return res.status(404).json({ error: 'Worker not found' });

    const sched = getSchedule();
    const weekendDay = {sun:0,mon:1,tue:2,wed:3,thu:4,fri:5,sat:6}[sched.weekend_day||'fri'] ?? 5;
    const [yy, mm] = month.split('-').map(Number);
    const daysInMonth = new Date(yy, mm, 0).getDate();
    const today = new Date();
    const endDay = (today.getFullYear()===yy && (today.getMonth()+1)===mm) ? today.getDate() : daysInMonth;

    // Attendance rows for this month
    const attRows = db.prepare(
      "SELECT * FROM attendance WHERE worker_id=? AND date LIKE ? ORDER BY date"
    ).all(+worker_id, month+'%');
    const attMap = {};
    attRows.forEach(a => { attMap[a.date] = a; });

    // Leave requests for this month
    const leaveRows = db.prepare(`
      SELECT lr.*, COALESCE(lt.is_paid,1) AS is_paid_flag
      FROM leave_requests lr
      LEFT JOIN leave_types lt ON lower(trim(lt.label))=lower(trim(lr.type))
      WHERE lr.worker_id=? AND lr.status='approved'
        AND (lr.date_from LIKE ? OR lr.date_to LIKE ?)
      ORDER BY lr.date_from
    `).all(+worker_id, month+'%', month+'%');

    // Build leave date map
    const leaveDateMap = {};
    leaveRows.forEach(lr => {
      const start = new Date(lr.date_from);
      const end   = new Date(lr.date_to || lr.date_from);
      for (let d = new Date(start); d <= end; d.setDate(d.getDate()+1)) {
        const ds = d.toISOString().slice(0,10);
        if (ds.startsWith(month)) {
          if (!leaveDateMap[ds]) leaveDateMap[ds] = [];
          leaveDateMap[ds].push(lr);
        }
      }
    });

    // Holidays
    const holidays = db.prepare("SELECT date, name FROM holidays WHERE date LIKE ?").all(month+'%');
    const holidayMap = {};
    holidays.forEach(h => { holidayMap[h.date] = h.name; });

    // Adjustments this month
    const adjRows = db.prepare(
      "SELECT * FROM payroll_adjustments WHERE worker_id=? AND (payroll_month=? OR (payroll_month IS NULL AND adjustment_date LIKE ?)) ORDER BY adjustment_date"
    ).all(+worker_id, month, month+'%');

    // Build daily log
    const days = [];
    for (let d = 1; d <= endDay; d++) {
      const dateStr = `${yy}-${String(mm).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      const dow = new Date(dateStr).getDay();
      const dayName = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dow];
      const isWeekend = dow === weekendDay;
      const isHoliday = !!holidayMap[dateStr];
      const att = attMap[dateStr];
      const leaves = leaveDateMap[dateStr] || [];
      const hasLeave = leaves.length > 0;

      let status = 'absent';
      if (isWeekend) status = 'weekend';
      else if (isHoliday) status = 'holiday';
      else if (att?.punch_in) status = 'present';
      else if (hasLeave) status = 'leave';

      // OT rate for this day
      let otRate = null;
      if (att?.punch_in) {
        if (isWeekend || isHoliday) otRate = 1.5;
        else if (att.overtime_status === 'approved') otRate = 1.25;
      }

      // Worked hours
      let workedHours = null;
      if (att?.punch_in && att?.punch_out) {
        const pin  = new Date(att.punch_in);
        const pout = new Date(att.punch_out);
        workedHours = Math.round(((pout - pin) / 3600000) * 100) / 100;
      }

      // OT hours
      let otHours = null;
      if (att?.punch_in && att?.punch_out && otRate === 1.25) {
        const shiftEnd = dow === 4 ? (sched.end_time_thu||sched.end_time||'16:30') : (sched.end_time||'16:30');
        const pout = String(att.punch_out);
        const poutTime = pout.length >= 16 ? pout.slice(11,16) : null;
        if (poutTime) {
          const [eh,em] = shiftEnd.split(':').map(Number);
          const [ph,pm] = poutTime.split(':').map(Number);
          const overMins = (ph*60+pm) - (eh*60+em);
          if (overMins > 0) otHours = Math.round((overMins/60)*100)/100;
        }
      } else if (att?.punch_in && (isWeekend||isHoliday)) {
        otHours = workedHours;
      }

      days.push({
        date: dateStr,
        day: dayName,
        status,
        punch_in:    att?.punch_in  ? String(att.punch_in).slice(11,16)  : null,
        punch_out:   att?.punch_out ? String(att.punch_out).slice(11,16) : null,
        worked_hours: workedHours,
        late_mins:   att?.late_mins || 0,
        ot_hours:    otHours,
        ot_rate:     otRate,
        holiday_name: holidayMap[dateStr] || null,
        leaves:      leaves.map(l => ({ type: l.type, kind: l.leave_kind, hours: l.hours, days: l.days }))
      });
    }

    res.json({
      worker: { id: w.id, name: w.name, hourly_rate: +w.hourly_rate||0, social_security_pct: +w.social_security_pct||0 },
      month,
      days,
      leaves:      leaveRows,
      adjustments: adjRows,
      holidays
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
