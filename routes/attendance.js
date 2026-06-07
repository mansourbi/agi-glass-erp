// routes/attendance.js
const router = require('express').Router();
const db     = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
router.use(requireAuth);

// ── Schema migrations ─────────────────────────────────────────────────────
try {
  db.prepare(`CREATE TABLE IF NOT EXISTS attendance (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    worker_id   INTEGER NOT NULL,
    worker_name TEXT    NOT NULL,
    date        TEXT    NOT NULL,           -- YYYY-MM-DD
    punch_in    DATETIME,                   -- full timestamp
    punch_out   DATETIME,
    total_mins  INTEGER,                    -- calculated on punch_out
    note        TEXT,
    created_at  DATETIME DEFAULT (datetime('now','localtime'))
  )`).run();
} catch(e) {}

// Add columns to existing table if missing
['punch_in','punch_out','total_mins','date','day_type'].forEach(col => {
  try { db.prepare(`ALTER TABLE attendance ADD COLUMN ${col} TEXT`).run(); } catch(e) {}
});

// ── Helpers ───────────────────────────────────────────────────────────────
const TZ_OFFSET = 3; // UTC+3
function localDate(d){ d=d||new Date(); d=new Date(d.getTime()+TZ_OFFSET*3600000); return d; }
function todayStr() { return localDate().toISOString().slice(0,10); }
function nowStr()   { return localDate().toISOString().replace('T',' ').slice(0,19); }

// Compute late_mins for an admin-entered punch_in.
// punchInStr can be 'YYYY-MM-DD HH:MM' or full ISO. Returns integer minutes;
// 0 if on-time, within tolerance, or if schedule not configured.
// Skips lateness on non-normal day types (weekend, holiday) and on dates
// where the worker has an approved leave (vacation, sick, etc).
function computeLateMins(punchInStr, dateStr, dayType, workerId) {
  if (!punchInStr) return 0;
  // Skip non-normal day types
  if (dayType && dayType !== 'normal') return 0;
  // Skip if worker has an approved leave covering this date
  if (workerId && dateStr) {
    try {
      const leave = db.prepare(
        "SELECT id FROM leave_requests WHERE worker_id=? AND status='approved' AND date_from<=? AND date_to>=? LIMIT 1"
      ).get(+workerId, dateStr, dateStr);
      if (leave) return 0;
    } catch(e) { /* table may not exist yet, fall through */ }
  }
  try {
    const sched = db.prepare('SELECT start_time, punch_in_tolerance_mins FROM work_schedule ORDER BY id LIMIT 1').get();
    if (!sched || !sched.start_time) return 0;
    const tolerance = +sched.punch_in_tolerance_mins || 10;
    const [sh, sm] = sched.start_time.split(':').map(Number);
    const schedStartMins = sh*60 + sm;
    // Extract HH:MM from the punch_in string
    const s = String(punchInStr);
    let hhmm = '';
    if (s.length >= 16 && s.charAt(10) === ' ') hhmm = s.slice(11,16);          // 'YYYY-MM-DD HH:MM...'
    else if (s.length >= 16 && s.charAt(10) === 'T') hhmm = s.slice(11,16);     // ISO
    else if (/^\d{1,2}:\d{2}$/.test(s)) hhmm = s;                                // 'HH:MM' alone
    else return 0;
    const [ph, pm] = hhmm.split(':').map(Number);
    if (isNaN(ph) || isNaN(pm)) return 0;
    const actualMins = ph*60 + pm;
    const diff = actualMins - schedStartMins;
    return diff > tolerance ? diff : 0;
  } catch(e) { console.warn('[computeLateMins]', e.message); return 0; }
}

// Ensure overtime audit/conflict columns exist
try { db.prepare('ALTER TABLE overtime ADD COLUMN conflict INTEGER DEFAULT 0').run(); } catch(e) {}
try { db.prepare('ALTER TABLE overtime ADD COLUMN edited_by TEXT').run(); } catch(e) {}
try { db.prepare('ALTER TABLE overtime ADD COLUMN edited_at DATETIME').run(); } catch(e) {}

// ── recomputeAutoOT ───────────────────────────────────────────────────────
// Single source of truth for punch-based overtime on one attendance record.
// - Computes OT from punch_out vs shift end (grace applied), Thu=15:00.
// - Weekend/holiday = whole worked shift is OT.
// - Updates attendance.overtime_mins AND upserts the linked AUTO overtime row.
// - Sub-grace => auto OT set to 0 + status 'rejected' (never deleted).
// - Leaves any MANUAL overtime row for that day untouched.
// - After upsert, if a live (non-rejected) manual OT also exists that day,
//   flags conflict=1 on both; otherwise clears conflict on the auto row.
// - Stamps edited_by/edited_at for traceability when opts.editedBy is given.
// opts: { status: 'pending'|'approved', editedBy: string|null, description: string|null }
function recomputeAutoOT(attendanceId, opts = {}) {
  const status   = opts.status || 'pending';
  const editedBy = opts.editedBy || null;
  const row = db.prepare('SELECT * FROM attendance WHERE id=?').get(+attendanceId);
  if (!row) return;

  const sched = db.prepare('SELECT end_time, thursday_end_time, punch_out_grace_mins FROM work_schedule ORDER BY id LIMIT 1').get() || {};
  const grace  = (+sched.punch_out_grace_mins) || 15;
  const endTime    = sched.end_time || '16:30';
  const thuEnd     = sched.thursday_end_time || '15:00';
  const dow = new Date(row.date).getDay();

  // Helper to pull HH:MM from a timestamp string
  const hhmm = (ts) => {
    if (!ts) return null;
    const s = String(ts);
    if (s.length >= 16 && (s.charAt(10)===' '||s.charAt(10)==='T')) return s.slice(11,16);
    if (/^\d{1,2}:\d{2}$/.test(s)) return s;
    return null;
  };
  const toMin = (t) => { if(!t) return null; const [h,m]=t.split(':').map(Number); return (isNaN(h)||isNaN(m))?null:h*60+m; };

  // Weekend/holiday OT is handled by its own (existing) logic and pay rates.
  // Per business rule it is NOT recomputed here — leave whatever is stored.
  if (row.day_type === 'weekend' || row.day_type === 'holiday') {
    return;
  }

  let overMins = 0;
  let autoDesc = opts.description || null;
  {
    const endStr = (dow === 4) ? thuEnd : endTime;
    const endMin = toMin(endStr);
    const outMin = toMin(hhmm(row.punch_out));
    if (outMin != null && endMin != null) {
      let raw = outMin - endMin;
      overMins = (raw > grace) ? raw : 0;
    }
    autoDesc = autoDesc || 'Auto: worked beyond ' + endStr;
  }

  // Update attendance.overtime_mins (punch-based value only)
  const newAttStatus = overMins > 0 ? status : 'none';
  db.prepare('UPDATE attendance SET overtime_mins=?, overtime_status=? WHERE id=?')
    .run(overMins, newAttStatus, row.id);

  // Upsert the linked AUTO overtime row
  const existingAuto = db.prepare("SELECT * FROM overtime WHERE attendance_id=? AND type='auto'").get(row.id);
  const startStr = (row.day_type==='weekend'||row.day_type==='holiday')
    ? (hhmm(row.punch_in) || '00:00')
    : ((dow===4)?thuEnd:endTime);
  const endStrOut = hhmm(row.punch_out) || '00:00';

  if (overMins <= 0) {
    // Sub-grace or no OT: reject the auto row if it exists (never delete)
    if (existingAuto) {
      db.prepare("UPDATE overtime SET mins=0, status='rejected', edited_by=?, edited_at=datetime('now','localtime') WHERE id=?")
        .run(editedBy, existingAuto.id);
    }
  } else {
    if (existingAuto) {
      db.prepare("UPDATE overtime SET mins=?, status=?, start_time=?, end_time=?, description=?, edited_by=?, edited_at=datetime('now','localtime') WHERE id=?")
        .run(overMins, status, startStr, endStrOut, autoDesc, editedBy, existingAuto.id);
    } else {
      const w = db.prepare('SELECT name FROM workers WHERE id=?').get(row.worker_id);
      db.prepare(`INSERT INTO overtime (worker_id,worker_name,date,type,start_time,end_time,mins,status,attendance_id,description,edited_by,edited_at,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,datetime('now','localtime'),datetime('now','localtime'))`)
        .run(row.worker_id, w?.name||row.worker_name||'', row.date, 'auto', startStr, endStrOut, overMins, status, row.id, autoDesc, editedBy);
    }
  }

  // Conflict detection: live auto + live manual same day
  const liveAuto   = db.prepare("SELECT id FROM overtime WHERE attendance_id=? AND type='auto' AND status!='rejected'").get(row.id);
  const liveManual = db.prepare("SELECT id FROM overtime WHERE worker_id=? AND date=? AND type='manual' AND status!='rejected'").get(row.worker_id, row.date);
  if (liveAuto && liveManual) {
    db.prepare("UPDATE overtime SET conflict=1 WHERE worker_id=? AND date=? AND status!='rejected'").run(row.worker_id, row.date);
  } else {
    db.prepare("UPDATE overtime SET conflict=0 WHERE attendance_id=? AND type='auto'").run(row.id);
  }
}

// Sweep recent attendance records for unattributed overtime.
// Call this lazily on admin list fetch: finds rows in the past N days
// where the worker worked past shift end (normal days) or worked at all
// (weekend/holiday) AND overtime_status is still 'none'. Flips them to
// 'pending' with notes so admin can review.
function autoFlagUnattributedOT(days = 7) {
  try {
    const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0,10);
    const rows = db.prepare(
      "SELECT id FROM attendance WHERE date>=? AND punch_in IS NOT NULL AND punch_out IS NOT NULL AND (overtime_status IS NULL OR overtime_status='none')"
    ).all(cutoff);
    // Delegate to the single source of truth — keeps attendance + overtime table in sync.
    // Worker hasn't decided yet, so leave as pending for admin review.
    rows.forEach(r => { recomputeAutoOT(r.id, { status: 'pending', editedBy: null }); });
  } catch(e) { console.warn('[autoFlagUnattributedOT]', e.message); }
}

// ── GET /today — worker's own today status ────────────────────────────────
router.get('/today', (req, res) => {
  try {
    const today = todayStr();
    const row = db.prepare(
      "SELECT * FROM attendance WHERE worker_id=? AND date=? ORDER BY id DESC LIMIT 1"
    ).get(req.user.id, today);
    res.json({
      row: row || null,
      punched_in:  !!(row && row.punch_in),
      punched_out: !!(row && row.punch_out)
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /punch-in ────────────────────────────────────────────────────────
router.post('/punch-in', (req, res) => {
  try {
    const today = todayStr();
    const existing = db.prepare(
      "SELECT * FROM attendance WHERE worker_id=? AND date=?"
    ).get(req.user.id, today);
    if (existing) return res.status(400).json({ error: 'Already punched in today' });
    // Auto-detect day type
    const dayOfWeek = new Date(today).getDay();
    const schedRow = db.prepare('SELECT weekend_day FROM work_schedule ORDER BY id LIMIT 1').get();
    const weekendDayName = (schedRow && schedRow.weekend_day) || 'fri';
    const dayMap = {0:'sun',1:'mon',2:'tue',3:'wed',4:'thu',5:'fri',6:'sat'};
    const dayName = dayMap[dayOfWeek];
    let auto_day_type = (dayName === weekendDayName) ? 'weekend' : 'normal';
    // Override with holiday if date is in the holidays table
    if (auto_day_type === 'normal') {
      try {
        const holiday = db.prepare('SELECT name FROM holidays WHERE date=?').get(today);
        if (holiday) auto_day_type = 'holiday';
      } catch(e) { /* holidays table may not exist yet */ }
    }
    const now = nowStr();
    // Detect lateness (skips weekend/holiday/approved-leave days via helper)
    const late_mins = computeLateMins(now, today, auto_day_type, req.user.id);
    const r = db.prepare(
      "INSERT INTO attendance (worker_id,worker_name,date,punch_in,type,day_type,late_mins) VALUES (?,?,?,?,?,?,?)"
    ).run(req.user.id, req.user.name, today, now, 'sign_in', auto_day_type, late_mins);
    res.status(201).json(db.prepare('SELECT * FROM attendance WHERE id=?').get(r.lastInsertRowid));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /punch-out ───────────────────────────────────────────────────────
router.post('/punch-out', (req, res) => {
  try {
    const today = todayStr();
    const row = db.prepare(
      "SELECT * FROM attendance WHERE worker_id=? AND date=?"
    ).get(req.user.id, today);
    if (!row)           return res.status(400).json({ error: 'Not punched in today' });
    if (row.punch_out)  return res.status(400).json({ error: 'Already punched out today' });
    const now = nowStr();
    const mins = Math.round((new Date(now) - new Date(row.punch_in)) / 60000);
    db.prepare(
      "UPDATE attendance SET punch_out=?, total_mins=? WHERE id=?"
    ).run(now, mins, row.id);
    // Weekend/holiday work is NOT overtime — whole day is paid at weekend/holiday
    // rate via total_mins in payroll. No overtime entry is created.
    const updated = db.prepare('SELECT * FROM attendance WHERE id=?').get(row.id);
    // Check if overtime territory (worker app will handle the prompt)
    try {
      const sched = db.prepare('SELECT end_time, thursday_end_time, punch_out_grace_mins FROM work_schedule ORDER BY id LIMIT 1').get();
      if (sched) {
        const dayOfWeek = new Date(today).getDay();
        const endTime = (dayOfWeek === 4) ? (sched.thursday_end_time||'15:00') : (sched.end_time||'16:30');
        const grace = +sched.punch_out_grace_mins || 15;
        const punchOutTime = now.slice(11,16);
        const [eh,em] = endTime.split(':').map(Number);
        const [ph,pm] = punchOutTime.split(':').map(Number);
        const overMins = (ph*60+pm) - (eh*60+em);
        // Return overtime info to worker app so it can prompt
        const overtimeDetected = overMins > grace;
        return res.json({ ...updated, overtime_detected: overtimeDetected, shift_end: endTime, over_mins: Math.max(0,overMins) });
      }
    } catch(e) { console.warn('[ot check]', e.message); }
    res.json(updated);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /overtime-decision — worker submits overtime yes/no ─────────────
router.post('/overtime-decision', (req, res) => {
  try {
    const { worked_overtime, project, notes } = req.body;
    const today = todayStr();
    const row = db.prepare("SELECT * FROM attendance WHERE worker_id=? AND date=? ORDER BY id DESC LIMIT 1").get(req.user.id, today);
    if (!row) return res.status(404).json({ error: 'No attendance record found for today' });
    if (!worked_overtime) {
      // Set punch_out to shift end time
      const sched = db.prepare('SELECT end_time, thursday_end_time FROM work_schedule ORDER BY id LIMIT 1').get();
      const dayOfWeek = new Date(today).getDay();
      const endTime = (dayOfWeek === 4) ? (sched?.thursday_end_time||'15:00') : (sched?.end_time||'16:30');
      const adjustedPunchOut = today + ' ' + endTime + ':00';
      const mins = Math.round((new Date(adjustedPunchOut) - new Date(row.punch_in)) / 60000);
      db.prepare("UPDATE attendance SET punch_out=?, total_mins=?, overtime_status='none', overtime_mins=0 WHERE id=?")
        .run(adjustedPunchOut, mins, row.id);
    } else {
      // Worker confirmed overtime. Store project on attendance, then let
      // recomputeAutoOT do the grace-correct calc + overtime-table upsert.
      db.prepare("UPDATE attendance SET overtime_notes=?, overtime_project=? WHERE id=?")
        .run(notes||null, project||null, row.id);
      recomputeAutoOT(row.id, { status: 'pending', description: project || notes || null });
    }
    res.json(db.prepare('SELECT * FROM attendance WHERE id=?').get(row.id));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /:id/overtime — admin approves/rejects overtime ─────────────────
// Body: { status: 'approved'|'rejected', notes?: string, overtime_mins?: number }
// If overtime_mins is provided and status='approved', stores the admin-edited
// value (clamped to [0, claimed_mins]). Used when admin approves a smaller
// amount than the worker claimed.
router.patch('/:id/overtime', requireAdmin, (req, res) => {
  try {
    const { status, notes, overtime_mins: omInput } = req.body;
    if (!['approved','rejected'].includes(status)) return res.status(400).json({ error: 'status must be approved or rejected' });
    const row = db.prepare('SELECT * FROM attendance WHERE id=?').get(+req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (status === 'rejected') {
      // Set punch_out back to shift end
      const sched = db.prepare('SELECT end_time, thursday_end_time FROM work_schedule ORDER BY id LIMIT 1').get();
      const dayOfWeek = new Date(row.date).getDay();
      const endTime = (dayOfWeek === 4) ? (sched?.thursday_end_time||'15:00') : (sched?.end_time||'16:30');
      const adjustedPunchOut = row.date + ' ' + endTime + ':00';
      const mins = Math.round((new Date(adjustedPunchOut) - new Date(row.punch_in)) / 60000);
      db.prepare("UPDATE attendance SET punch_out=?, total_mins=?, overtime_status='rejected', overtime_mins=0, overtime_notes=? WHERE id=?")
        .run(adjustedPunchOut, mins, notes||null, +req.params.id);
    } else {
      // Approve — optionally override overtime_mins with a smaller value
      let approvedMins = +row.overtime_mins || 0; // default: what was claimed
      if (omInput !== undefined && omInput !== null && omInput !== '') {
        const n = Math.round(+omInput);
        if (isNaN(n) || n < 0) return res.status(400).json({ error: 'overtime_mins must be a non-negative number' });
        // Admin can reduce but not inflate above what was claimed
        const claimed = +row.overtime_mins || 0;
        if (n > claimed) return res.status(400).json({ error: `Cannot approve more than claimed (${claimed} mins)` });
        approvedMins = n;
      }
      // If admin approved 0 mins, treat as reject semantics (no OT paid)
      if (approvedMins === 0) {
        db.prepare("UPDATE attendance SET overtime_status='approved', overtime_mins=0, overtime_notes=? WHERE id=?")
          .run(notes || 'Approved 0 mins (no OT)', +req.params.id);
      } else {
        db.prepare("UPDATE attendance SET overtime_status='approved', overtime_mins=?, overtime_notes=? WHERE id=?")
          .run(approvedMins, notes||null, +req.params.id);
      }
    }
    res.json(db.prepare('SELECT * FROM attendance WHERE id=?').get(+req.params.id));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /pending-overtime — admin list of pending overtime requests ─────────
router.get('/pending-overtime', requireAdmin, (req, res) => {
  try {
    // Lazy sweep: promote unattributed OT to pending before returning the list
    autoFlagUnattributedOT(14);
    const rows = db.prepare("SELECT * FROM attendance WHERE overtime_status='pending' ORDER BY date DESC").all();
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /schedule — public schedule for worker app ────────────────────────
router.get('/schedule', (req, res) => {
  try {
    const s = db.prepare('SELECT start_time, end_time, thursday_end_time, break_mins, punch_in_tolerance_mins, punch_out_grace_mins, weekend_day FROM work_schedule ORDER BY id LIMIT 1').get();
    res.json(s || {});
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /admin list with filters ──────────────────────────────────────────
// ── GET / — admin list with filters ──────────────────────────────────────
router.get('/', (req, res) => {
  try {
    // Lazy sweep: auto-flag unattributed OT from the past week before returning data
    autoFlagUnattributedOT(7);
    const { date_from, date_to, worker_id } = req.query;
    let sql = 'SELECT * FROM attendance WHERE 1=1';
    const p = [];
    if (date_from) { sql += ' AND date>=?'; p.push(date_from); }
    if (date_to)   { sql += ' AND date<=?'; p.push(date_to); }
    if (worker_id) { sql += ' AND worker_id=?'; p.push(+worker_id); }
    sql += ' ORDER BY date DESC, worker_name';
    res.json(db.prepare(sql).all(...p));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /summary — monthly summary per worker ─────────────────────────────
router.get('/summary', requireAdmin, (req, res) => {
  try {
    const { month, worker_id } = req.query; // month = YYYY-MM
    let sql = `SELECT worker_id, worker_name,
      COUNT(*) as days_worked,
      SUM(total_mins) as total_mins,
      SUM(CASE WHEN total_mins > 480 THEN total_mins - 480 ELSE 0 END) as overtime_mins
      FROM attendance WHERE punch_in IS NOT NULL`;
    const p = [];
    if (month)     { sql += ' AND date LIKE ?'; p.push(month+'%'); }
    if (worker_id) { sql += ' AND worker_id=?'; p.push(+worker_id); }
    sql += ' GROUP BY worker_id, worker_name ORDER BY worker_name';
    res.json(db.prepare(sql).all(...p));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: override/create attendance record ─────────────────────────────
router.patch('/:id/override', requireAdmin, (req, res) => {
  try {
    const { punch_in, punch_out } = req.body;
    const row = db.prepare('SELECT * FROM attendance WHERE id=?').get(+req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    let total_mins = null;
    if (punch_in && punch_out) {
      total_mins = Math.round((new Date(punch_out) - new Date(punch_in)) / 60000);
    }
    // Recalculate late_mins whenever punch_in is provided (even if unchanged — safe)
    const newPunchIn = punch_in || row.punch_in;
    const late_mins = computeLateMins(newPunchIn, row.date, row.day_type, row.worker_id);
    db.prepare('UPDATE attendance SET punch_in=?,punch_out=?,total_mins=?,late_mins=? WHERE id=?')
      .run(newPunchIn, punch_out||row.punch_out, total_mins, late_mins, +req.params.id);
    // Recompute punch-based OT after admin edit — overwrite auto OT, approved (admin blessing)
    recomputeAutoOT(+req.params.id, { status: 'approved', editedBy: req.user.name });
    res.json(db.prepare('SELECT * FROM attendance WHERE id=?').get(+req.params.id));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: update day type ───────────────────────────────────────────────
router.patch('/:id/day-type', requireAdmin, (req, res) => {
  try {
    const { day_type } = req.body;
    const allowed = ['normal','weekend','holiday'];
    if (!allowed.includes(day_type)) return res.status(400).json({ error: 'day_type must be: '+allowed.join(', ') });
    const row = db.prepare('SELECT * FROM attendance WHERE id=?').get(+req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    // Recompute late_mins with the new day_type (will be 0 for weekend/holiday)
    const late_mins = computeLateMins(row.punch_in, row.date, day_type, row.worker_id);
    db.prepare('UPDATE attendance SET day_type=?, late_mins=? WHERE id=?').run(day_type, late_mins, +req.params.id);
    // Day-type change affects OT calc
    if (day_type === 'weekend' || day_type === 'holiday') {
      // Weekend/holiday is not overtime — reject any existing auto OT for that day,
      // clear attendance OT. Whole day paid at weekend/holiday rate in payroll.
      db.prepare("UPDATE overtime SET mins=0, status='rejected', edited_by=?, edited_at=datetime('now','localtime') WHERE attendance_id=? AND type='auto'")
        .run(req.user.name, +req.params.id);
      db.prepare("UPDATE attendance SET overtime_mins=0, overtime_status='none' WHERE id=?").run(+req.params.id);
    } else {
      recomputeAutoOT(+req.params.id, { status: 'approved', editedBy: req.user.name });
    }
    res.json(db.prepare('SELECT * FROM attendance WHERE id=?').get(+req.params.id));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/admin', requireAdmin, (req, res) => {
  try {
    const { worker_id, date, punch_in, punch_out } = req.body;
    if (!worker_id || !date) return res.status(400).json({ error: 'worker_id and date required' });
    const worker = db.prepare('SELECT name FROM workers WHERE id=?').get(+worker_id);
    if (!worker) return res.status(404).json({ error: 'Worker not found' });
    const pin  = punch_in  ? date+' '+punch_in  : null;
    const pout = punch_out ? date+' '+punch_out : null;
    const total_mins = pin && pout ? Math.round((new Date(pout) - new Date(pin)) / 60000) : null;
    // Determine day_type first so lateness can skip non-normal days
    const existing = db.prepare("SELECT id, day_type FROM attendance WHERE worker_id=? AND date=?").get(+worker_id, date);
    let effDayType;
    if (existing && existing.day_type) {
      effDayType = existing.day_type;
    } else {
      const dayOfWeek2 = new Date(date).getDay();
      const schedRow2 = db.prepare('SELECT weekend_day FROM work_schedule ORDER BY id LIMIT 1').get();
      const wdn2 = (schedRow2 && schedRow2.weekend_day) || 'fri';
      const dm2 = {0:'sun',1:'mon',2:'tue',3:'wed',4:'thu',5:'fri',6:'sat'};
      effDayType = (dm2[dayOfWeek2] === wdn2) ? 'weekend' : 'normal';
      // Override with holiday if in holidays table
      if (effDayType === 'normal') {
        try {
          const holiday = db.prepare('SELECT name FROM holidays WHERE date=?').get(date);
          if (holiday) effDayType = 'holiday';
        } catch(e) {}
      }
    }
    const late_mins = computeLateMins(pin, date, effDayType, +worker_id);
    if (existing) {
      db.prepare('UPDATE attendance SET punch_in=?,punch_out=?,total_mins=?,late_mins=? WHERE id=?')
        .run(pin, pout, total_mins, late_mins, existing.id);
      if (pout) recomputeAutoOT(existing.id, { status: 'approved', editedBy: req.user.name });
      res.json(db.prepare('SELECT * FROM attendance WHERE id=?').get(existing.id));
    } else {
      const r = db.prepare("INSERT INTO attendance (worker_id,worker_name,date,punch_in,punch_out,total_mins,type,day_type,late_mins) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(+worker_id, worker.name, date, pin, pout, total_mins, 'sign_in', effDayType, late_mins);
      if (pout) recomputeAutoOT(r.lastInsertRowid, { status: 'approved', editedBy: req.user.name });
      res.status(201).json(db.prepare('SELECT * FROM attendance WHERE id=?').get(r.lastInsertRowid));
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: delete attendance record ─────────────────────────────────────
router.delete('/:id', requireAdmin, (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM attendance WHERE id=?').get(+req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    db.prepare('DELETE FROM attendance WHERE id=?').run(+req.params.id);
    res.json({ deleted: true, id: +req.params.id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Legacy support ────────────────────────────────────────────────────────
router.get('/all', (req, res) => res.redirect('/api/attendance?date='+todayStr()));

module.exports = router;
