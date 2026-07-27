// routes/dashboard.js - aggregated dashboard metrics (WoW/MoM)
const router = require('express').Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
router.use(requireAuth);

const FADL = '%\u0641\u0636\u0644%';
const pad = n => String(n).padStart(2,'0');
const fmt = d => d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());

function ranges(){
  const now = new Date();
  const today = fmt(now);
  const sinceSat = (now.getDay() - 6 + 7) % 7;            // week starts Saturday
  const wStart = new Date(now); wStart.setDate(now.getDate() - sinceSat);
  // Like-for-like: compare elapsed portion only (Sat..today vs last week's Sat..same offset;
  // month-to-date vs same day-count of last month)
  const lwStart = new Date(wStart); lwStart.setDate(wStart.getDate() - 7);
  const lwEnd = new Date(lwStart); lwEnd.setDate(lwStart.getDate() + sinceSat);
  const mStart = today.slice(0,8) + '01';
  const lmStart = fmt(new Date(now.getFullYear(), now.getMonth()-1, 1));
  const lmLastDay = new Date(now.getFullYear(), now.getMonth(), 0).getDate();
  const lmEnd = fmt(new Date(now.getFullYear(), now.getMonth()-1, Math.min(now.getDate(), lmLastDay)));
  return { tw:[fmt(wStart), today], lw:[fmt(lwStart), fmt(lwEnd)], tm:[mStart, today], lm:[lmStart, lmEnd] };
}

function workingDays(from, to){
  let wd = [];
  try { wd = JSON.parse((db.prepare('SELECT work_days FROM work_schedule LIMIT 1').get()||{}).work_days || '[]'); } catch(e){}
  if (!wd.length) wd = ['mon','tue','wed','thu','sat','sun'];
  const hol = new Set();
  try { db.prepare('SELECT date FROM holidays WHERE date>=? AND date<=?').all(from,to).forEach(r=>hol.add(r.date)); } catch(e){}
  const names = ['sun','mon','tue','wed','thu','fri','sat'];
  let n = 0;
  const c = new Date(from+'T00:00:00'), end = new Date(to+'T00:00:00');
  while (c <= end){ if (wd.includes(names[c.getDay()]) && !hol.has(fmt(c))) n++; c.setDate(c.getDate()+1); }
  return Math.max(1, n);
}

const FADL_CASE = `CASE WHEN (
  EXISTS(SELECT 1 FROM opt_files o JOIN raw_sheets r ON r.id=o.raw_sheet_id WHERE o.id=cm.opt_file_id AND (r.code LIKE '${FADL}' OR r.notes LIKE '${FADL}'))
  OR EXISTS(SELECT 1 FROM opt_files o2 WHERE o2.id=cm.opt_file_id AND o2.raw_sheet_snap LIKE '${FADL}')
  OR EXISTS(SELECT 1 FROM cutting_movement_slots x JOIN raw_sheets r2 ON r2.id=x.sheet_id WHERE x.movement_id=cm.id AND (r2.code LIKE '${FADL}' OR r2.notes LIKE '${FADL}'))
) THEN 0 ELSE cm.sheets_total END`;

const q = {
  sqmThickness: r => db.prepare("SELECT oi.thickness th, ROUND(SUM(oi.w*oi.h/1000000.0*oi.qty),2) sqm FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.date>=? AND o.date<=? AND o.status!='cancelled' GROUP BY oi.thickness ORDER BY oi.thickness").all(r[0],r[1]),
  scans:        r => db.prepare("SELECT process, COUNT(*) c FROM scan_log WHERE action='done' AND substr(ts,1,10)>=? AND substr(ts,1,10)<=? GROUP BY process").all(r[0],r[1]),
  sheetsCut:    r => db.prepare(`SELECT COALESCE(SUM(${FADL_CASE}),0) s FROM cutting_movements cm WHERE cm.movement_date>=? AND cm.movement_date<=?`).get(r[0],r[1]).s,
  piecesCut:    r => db.prepare("SELECT COUNT(*) c FROM scan_log WHERE action='done' AND process='cutting' AND substr(ts,1,10)>=? AND substr(ts,1,10)<=?").get(r[0],r[1]).c,
  deliveries:   r => db.prepare("SELECT COUNT(*) c FROM deliveries WHERE status='finalised' AND substr(finalised_at,1,10)>=? AND substr(finalised_at,1,10)<=?").get(r[0],r[1]).c,
  remakes:      r => db.prepare("SELECT COALESCE(SUM(CASE WHEN COALESCE(order_type,'normal')!='normal' THEN 1 ELSE 0 END),0) rem, COUNT(*) tot FROM orders WHERE date>=? AND date<=? AND status!='cancelled'").get(r[0],r[1])
};

router.get('/summary', (req, res) => {
  try {
    const R = ranges();
    const out = { ranges: R, workingDays: {}, sqmThickness: {}, scans: {}, sheetsCut: {}, piecesCut: {}, deliveries: {}, remakes: {} };
    for (const k of ['tw','lw','tm','lm']){
      out.workingDays[k]  = workingDays(R[k][0], R[k][1]);
      out.sqmThickness[k] = q.sqmThickness(R[k]);
      out.scans[k]        = q.scans(R[k]);
      out.sheetsCut[k]    = q.sheetsCut(R[k]);
      out.piecesCut[k]    = q.piecesCut(R[k]);
      out.deliveries[k]   = q.deliveries(R[k]);
      out.remakes[k]      = q.remakes(R[k]);
    }
    const since = (()=>{ const d=new Date(); d.setDate(d.getDate()-7); return fmt(d); })();
    out.hr = {
      late:     db.prepare("SELECT worker_name, date, late_mins, late_reason FROM attendance WHERE date>=? AND late_mins>0 ORDER BY date DESC, worker_name LIMIT 30").all(since),
      early:    db.prepare("SELECT worker_name, date, early_leave_mins, early_leave_reason FROM attendance WHERE date>=? AND early_leave_mins>0 ORDER BY date DESC, worker_name LIMIT 30").all(since),
      overtime: db.prepare("SELECT worker_name, date, mins, status, type, description FROM overtime WHERE date>=? AND status!='rejected' AND mins>0 ORDER BY date DESC, worker_name LIMIT 30").all(since)
    };
    res.json(out);
  } catch(e){ res.status(500).json({ error: e.message }); }
});

module.exports = router;
