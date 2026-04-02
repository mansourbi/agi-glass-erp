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
    const auto_day_type = (dayName === weekendDayName) ? 'weekend' : 'normal';
    const r = db.prepare(
      "INSERT INTO attendance (worker_id,worker_name,date,punch_in,type,day_type) VALUES (?,?,?,?,?,?)"
    ).run(req.user.id, req.user.name, today, nowStr(), 'sign_in', auto_day_type);
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
    const updated = db.prepare('SELECT * FROM attendance WHERE id=?').get(row.id);
    // Auto-generate overtime if punched out after schedule end
    try {
      const sched = db.prepare('SELECT end_time FROM work_schedule ORDER BY id LIMIT 1').get();
      if (sched) {
        const endTime = sched.end_time;
        const punchOutTime = now.slice(11,16);
        const [eh,em] = endTime.split(':').map(Number);
        const [ph,pm] = punchOutTime.split(':').map(Number);
        const overMins = (ph*60+pm) - (eh*60+em);
        if (overMins > 5) { // >5 min grace period
          const existing = db.prepare("SELECT id FROM overtime WHERE worker_id=? AND date=? AND type='auto'")
            .get(req.user.id, today);
          if (!existing) {
            db.prepare(`INSERT INTO overtime (worker_id,worker_name,date,type,start_time,end_time,mins,description,attendance_id)
              VALUES (?,?,?,?,?,?,?,?,?)`)
              .run(req.user.id, req.user.name, today, 'auto', endTime, punchOutTime, overMins,
                'Auto: worked beyond '+endTime, updated.id);
          }
        }
      }
    } catch(e) { console.warn('[auto-ot]', e.message); }
    res.json(updated);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET / — admin list with filters ──────────────────────────────────────
router.get('/', (req, res) => {
  try {
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
    db.prepare('UPDATE attendance SET punch_in=?,punch_out=?,total_mins=? WHERE id=?')
      .run(punch_in||row.punch_in, punch_out||row.punch_out, total_mins, +req.params.id);
    res.json(db.prepare('SELECT * FROM attendance WHERE id=?').get(+req.params.id));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: update day type ───────────────────────────────────────────────
router.patch('/:id/day-type', requireAdmin, (req, res) => {
  try {
    const { day_type } = req.body;
    const allowed = ['normal','weekend','holiday'];
    if (!allowed.includes(day_type)) return res.status(400).json({ error: 'day_type must be: '+allowed.join(', ') });
    db.prepare('UPDATE attendance SET day_type=? WHERE id=?').run(day_type, +req.params.id);
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
    // Check if record exists for this date
    const existing = db.prepare("SELECT id FROM attendance WHERE worker_id=? AND date=?").get(+worker_id, date);
    if (existing) {
      db.prepare('UPDATE attendance SET punch_in=?,punch_out=?,total_mins=? WHERE id=?')
        .run(pin, pout, total_mins, existing.id);
      res.json(db.prepare('SELECT * FROM attendance WHERE id=?').get(existing.id));
    } else {
      const dayOfWeek2 = new Date(date).getDay();
    const schedRow2 = db.prepare('SELECT weekend_day FROM work_schedule ORDER BY id LIMIT 1').get();
    const wdn2 = (schedRow2 && schedRow2.weekend_day) || 'fri';
    const dm2 = {0:'sun',1:'mon',2:'tue',3:'wed',4:'thu',5:'fri',6:'sat'};
    const auto_dt = (dm2[dayOfWeek2] === wdn2) ? 'weekend' : 'normal';
    const r = db.prepare("INSERT INTO attendance (worker_id,worker_name,date,punch_in,punch_out,total_mins,type,day_type) VALUES (?,?,?,?,?,?,?,?)")
        .run(+worker_id, worker.name, date, pin, pout, total_mins, 'sign_in', auto_dt);
      res.status(201).json(db.prepare('SELECT * FROM attendance WHERE id=?').get(r.lastInsertRowid));
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Legacy support ────────────────────────────────────────────────────────
router.get('/all', (req, res) => res.redirect('/api/attendance?date='+todayStr()));

module.exports = router;
