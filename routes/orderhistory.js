// routes/orderhistory.js - full lifecycle timeline for one order.
// Answers "why did this take so long": stage-by-stage elapsed time, separating
// calendar time from working time (weekends and holidays excluded).
const router = require('express').Router();
const db     = require('../db');
const { requireAuth } = require('../middleware/auth');
router.use(requireAuth);

function workDayMinutes(fromISO, toISO, holidays, workDays, dayStart, dayEnd){
  // count working minutes between two timestamps
  const a=new Date(String(fromISO).replace(' ','T')), b=new Date(String(toISO).replace(' ','T'));
  if(isNaN(a)||isNaN(b)||b<=a) return 0;
  const DAYN=['sun','mon','tue','wed','thu','fri','sat'];
  let mins=0; const cur=new Date(a);
  while(cur<b){
    // local date parts - toISOString() would shift the day (UTC) and skip weekends
    const _p=n=>(n<10?'0':'')+n;
    const d=cur.getFullYear()+'-'+_p(cur.getMonth()+1)+'-'+_p(cur.getDate());
    const isWork = workDays.has(DAYN[cur.getDay()]) && !holidays.has(d);
    // (workDays is normalised to 3-letter lowercase when loaded)
    if(isWork){
      const s=new Date(d+'T'+dayStart+':00'), e=new Date(d+'T'+dayEnd+':00');
      const from=(cur>s)?cur:s, to=(b<e)?b:e;
      if(to>from) mins += (to-from)/60000;
    }
    cur.setDate(cur.getDate()+1); cur.setHours(0,0,0,0);
  }
  return Math.round(mins);
}

router.get('/:num', (req,res)=>{
  try{
    const num=req.params.num;
    const o=db.prepare('SELECT * FROM orders WHERE num=?').get(num);
    if(!o) return res.status(404).json({error:'Order not found'});

    // working calendar
    const holidays=new Set(db.prepare('SELECT date FROM holidays').all().map(r=>String(r.date).slice(0,10)));
    let workDays=new Set(['sun','mon','tue','wed','thu','sat']), dayStart='08:00', dayEnd='16:30';
    try{
      const sc=db.prepare('SELECT * FROM work_schedule LIMIT 1').get();
      if(sc){
        if(sc.work_days){ try{
          const raw=JSON.parse(sc.work_days);
          const NUM=['sun','mon','tue','wed','thu','fri','sat'];
          workDays=new Set(raw.map(x=>{
            if(typeof x==='number') return NUM[x];
            return String(x).trim().toLowerCase().slice(0,3);
          }));
        }catch(e){} }
        if(sc.start_time) dayStart=String(sc.start_time).slice(0,5);
        if(sc.end_time)   dayEnd=String(sc.end_time).slice(0,5);
      }
    }catch(e){}

    const items=db.prepare('SELECT id,w,h,qty,thickness,processes,piece_uids FROM order_items WHERE order_id=?').all(o.id);
    let pieces=0, sqm=0;
    items.forEach(i=>{ pieces+=(+i.qty||0); sqm+=((+i.w||0)*(+i.h||0)/1e6)*(+i.qty||0); });

    const events=[];
    const add=(ts,type,label,detail)=>{ if(ts) events.push({ts:String(ts).replace('T',' ').slice(0,19),type,label,detail:detail||''}); };

    add(o.created_at,'created','Order created', 'by '+(o.created_by||'-')+(o.date?(' | order date '+o.date):''));
    const lb=db.prepare('SELECT MIN(created_at) f, COUNT(*) c FROM label_items WHERE order_num=?').get(num);
    if(lb && lb.c) add(lb.f,'labels','Labels created', lb.c+' pieces');
    db.prepare("SELECT id,name,status,created_at FROM opt_files WHERE cut_pieces LIKE ?").all('%"'+num+'"%')
      .forEach(f=>add(f.created_at,'opt','Optimization #'+f.id,(f.name||'').slice(0,70)));

    const scans=db.prepare('SELECT piece_uid,process,action,ts,worker_name FROM scan_log WHERE order_num=? ORDER BY ts').all(num);
    // stage boundaries per process
    const byProc={};
    scans.filter(s=>s.action==='done').forEach(s=>{
      if(!byProc[s.process]) byProc[s.process]={first:s.ts,last:s.ts,n:0,workers:new Set()};
      const p=byProc[s.process];
      if(s.ts<p.first) p.first=s.ts;
      if(s.ts>p.last)  p.last=s.ts;
      p.n++; if(s.worker_name) p.workers.add(s.worker_name);
    });
    Object.entries(byProc).forEach(([proc,p])=>{
      add(p.first,'proc_start',proc+' started', p.n+' pieces | '+[...p.workers].join(', '));
      if(p.last!==p.first) add(p.last,'proc_end',proc+' finished','');
    });

    if(o.completed_at) add(o.completed_at,'done','Order marked done','by '+(o.completed_by||'-'));
    if(o.cancelled_at) add(o.cancelled_at,'cancelled','Order cancelled',(o.cancel_reason||''));

    db.prepare(`SELECT d.serial,d.status,d.created_at,d.finalised_at,d.receiver_name,d.factory_name,COUNT(di.id) n
                FROM deliveries d JOIN delivery_items di ON di.delivery_id=d.id
                WHERE di.order_num=? GROUP BY d.id ORDER BY d.created_at`).all(num)
      .forEach(d=>{
        add(d.created_at,'dlv_open','Delivery '+d.serial+' opened', d.n+' pieces');
        if(d.finalised_at) add(d.finalised_at,'dlv_final','Delivery '+d.serial+' finalised',
          [d.receiver_name,d.factory_name].filter(Boolean).join(' / '));
      });

    events.sort((a,b)=>a.ts.localeCompare(b.ts));
    // gaps
    for(let i=0;i<events.length;i++){
      if(i===0){ events[i].gap_hours=0; events[i].gap_work_hours=0; continue; }
      const prev=events[i-1].ts, cur=events[i].ts;
      const ms=new Date(cur.replace(' ','T'))-new Date(prev.replace(' ','T'));
      events[i].gap_hours=Math.round(ms/36e5*10)/10;
      events[i].gap_work_hours=Math.round(workDayMinutes(prev,cur,holidays,workDays,dayStart,dayEnd)/6)/10;
    }

    const first=events[0]?events[0].ts:null, last=events[events.length-1]?events[events.length-1].ts:null;
    const totalH=(first&&last)?Math.round((new Date(last.replace(' ','T'))-new Date(first.replace(' ','T')))/36e5*10)/10:0;
    const totalW=(first&&last)?Math.round(workDayMinutes(first,last,holidays,workDays,dayStart,dayEnd)/6)/10:0;
    const slowest=events.slice(1).sort((a,b)=>b.gap_work_hours-a.gap_work_hours)[0]||null;

    // ---- stage summary -----------------------------------------------------
    const doneScans=scans.filter(x=>x.action==='done').map(x=>x.ts).sort();
    const firstScan=doneScans[0]||null, lastScan=doneScans[doneScans.length-1]||null;
    const dlv=db.prepare(`SELECT d.serial,d.finalised_at,d.created_at FROM deliveries d
                          JOIN delivery_items di ON di.delivery_id=d.id
                          WHERE di.order_num=? GROUP BY d.id ORDER BY d.created_at`).all(num);
    const firstDlv=dlv[0]||null, lastDlv=dlv[dlv.length-1]||null;
    const hrs=(a,b)=>(a&&b)?Math.round((new Date(String(b).replace(' ','T'))-new Date(String(a).replace(' ','T')))/36e5*10)/10:null;
    const wh =(a,b)=>(a&&b)?Math.round(workDayMinutes(a,b,holidays,workDays,dayStart,dayEnd)/6)/10:null;
    // estimated hands-on time: cluster scans into sessions (gap > 30 min = new session)
    let active=0, sessions=0;
    if(doneScans.length){
      let sStart=doneScans[0], prev=doneScans[0];
      for(let i=1;i<doneScans.length;i++){
        const g=(new Date(doneScans[i].replace(' ','T'))-new Date(prev.replace(' ','T')))/60000;
        if(g>30){ active+=(new Date(prev.replace(' ','T'))-new Date(sStart.replace(' ','T')))/60000+5; sessions++; sStart=doneScans[i]; }
        prev=doneScans[i];
      }
      active+=(new Date(prev.replace(' ','T'))-new Date(sStart.replace(' ','T')))/60000+5; sessions++;
    }
    const optRow=db.prepare("SELECT MIN(created_at) f, COUNT(*) c FROM opt_files WHERE cut_pieces LIKE ?").get('%"'+num+'"%');
    const lblRow=db.prepare("SELECT MIN(created_at) f FROM label_items WHERE order_num=?").get(num);
    const summary={
      created_at:o.created_at, first_scan:firstScan, last_scan:lastScan,
      labels_at:(lblRow&&lblRow.f)||null,
      optimized_at:(optRow&&optRow.f)||null, opt_files:(optRow&&optRow.c)||0,
      completed_at:o.completed_at,
      first_delivery:firstDlv?(firstDlv.finalised_at||firstDlv.created_at):null,
      last_delivery:lastDlv?(lastDlv.finalised_at||lastDlv.created_at):null,
      deliveries:dlv.length,
      queue_h:hrs(o.created_at,firstScan),         queue_wh:wh(o.created_at,firstScan),
      production_h:hrs(firstScan,lastScan),        production_wh:wh(firstScan,lastScan),
      to_delivery_h:hrs(o.completed_at||lastScan, lastDlv?(lastDlv.finalised_at||lastDlv.created_at):null),
      to_delivery_wh:wh(o.completed_at||lastScan, lastDlv?(lastDlv.finalised_at||lastDlv.created_at):null),
      lead_h:hrs(o.created_at, lastDlv?(lastDlv.finalised_at||lastDlv.created_at):(o.completed_at||lastScan)),
      lead_wh:wh(o.created_at, lastDlv?(lastDlv.finalised_at||lastDlv.created_at):(o.completed_at||lastScan)),
      // "Ready at factory" = last production scan (or the completion stamp).
      // Everything after that is waiting for collection, which the factory does
      // not control - so it is reported separately from production time.
      ready_at: lastScan || o.completed_at || null,
      factory_h:  hrs(o.created_at, lastScan||o.completed_at),
      factory_wh: wh (o.created_at, lastScan||o.completed_at),
      wait_first_pickup_h:  hrs(lastScan||o.completed_at, firstDlv?(firstDlv.finalised_at||firstDlv.created_at):null),
      wait_first_pickup_wh: wh (lastScan||o.completed_at, firstDlv?(firstDlv.finalised_at||firstDlv.created_at):null),
      wait_last_pickup_h:   hrs(lastScan||o.completed_at, lastDlv?(lastDlv.finalised_at||lastDlv.created_at):null),
      wait_last_pickup_wh:  wh (lastScan||o.completed_at, lastDlv?(lastDlv.finalised_at||lastDlv.created_at):null),
      active_work_h:Math.round(active/6)/10, work_sessions:sessions,
      // first/last scan per process, in the order work actually started
      processes: Object.entries(byProc)
        .map(([proc,p])=>({ process:proc, first:p.first, last:p.last, pieces:p.n,
                            workers:[...p.workers].join(', '),
                            span_h:hrs(p.first,p.last), span_wh:wh(p.first,p.last) }))
        .sort((a,b)=>String(a.first).localeCompare(String(b.first)))
    };
    res.json({
      summary,
      order:{num:o.num,id:o.id,status:o.status,date:o.date,created_at:o.created_at,completed_at:o.completed_at,
             pieces,items:items.length,sqm:Math.round(sqm*1000)/1000,external_process_id:o.external_process_id},
      totals:{elapsed_hours:totalH, working_hours:totalW,
              elapsed_days:Math.round(totalH/24*10)/10, working_days:Math.round(totalW/8*10)/10},
      slowest_step:slowest,
      events, scans_count:scans.length,
      calendar:{work_days:[...workDays], day_start:dayStart, day_end:dayEnd, holidays_in_range:[...holidays].filter(h=>first&&last&&h>=first.slice(0,10)&&h<=last.slice(0,10))}
    });
  }catch(e){ res.status(500).json({error:e.message}); }
});

module.exports = router;
