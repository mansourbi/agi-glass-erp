// routes/gsheet-sync.js - hourly push of available remnants to Google Sheet (Apps Script Web App)
const router = require('express').Router();
const db = require('../db');
const https = require('https');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const SYNC_URL = process.env.GSHEET_SYNC_URL || '';
const SECRET   = process.env.GSHEET_SYNC_SECRET || '';
const HEADERS = ['UID','Width','Height','Thickness','Type','Color','Family','Pattern','Brand','Origin','SQM','Slot','Notes','Source','Opt File','Created At'];

function collect(){
  return db.prepare(`SELECT uid,w,h,thickness,glass_type,color,family,pattern,brand,origin,sqm,slot_code,notes,source,opt_file_name,created_at
    FROM remnants WHERE status='available' ORDER BY thickness, w*h DESC`).all()
    .map(r=>[r.uid,r.w,r.h,r.thickness,r.glass_type,r.color,r.family||'',r.pattern||'',r.brand||'',r.origin||'',r.sqm,r.slot_code||'',r.notes||'',r.source||'',r.opt_file_name||'',r.created_at]);
}

function syncNow(cb){
  if(!SYNC_URL || !SECRET){ console.log('[gsheet] not configured (GSHEET_SYNC_URL / GSHEET_SYNC_SECRET)'); if(cb) cb({skipped:true}); return; }
  try{
    const rows = collect();
    const body = JSON.stringify({ secret: SECRET, headers: HEADERS, rows });
    const u = new URL(SYNC_URL);
    const doReq = (host, path, method, payload, hops) => {
      const req = https.request({ hostname:host, path:path, method:method,
        headers: payload ? { 'Content-Type':'application/json', 'Content-Length':Buffer.byteLength(payload) } : {} }, res => {
        if((res.statusCode===301||res.statusCode===302||res.statusCode===307) && res.headers.location && hops<4){
          const l = new URL(res.headers.location);
          res.resume();
          return doReq(l.hostname, l.pathname+l.search, 'GET', null, hops+1);  // Apps Script redirect target is a GET
        }
        let data=''; res.on('data',d=>data+=d);
        res.on('end',()=>{ const txt=String(data).slice(0,200);
          const ok = res.statusCode===200 && txt.indexOf('forbidden')<0 && txt.indexOf('"ok":false')<0;
          console.log('[gsheet] sync', res.statusCode, 'rows='+rows.length, 'resp='+txt);
          if(cb){ cb({ ok, status:res.statusCode, rows:rows.length, resp:txt }); cb=null; } });
      });
      req.on('error', e=>{ console.warn('[gsheet] sync failed:', e.message); if(cb){ cb({ok:false,error:e.message}); cb=null; } });
      req.setTimeout(30000, ()=>req.destroy(new Error('timeout')));
      if(payload) req.write(payload);
      req.end();
    };
    const req = { on:function(){return this;}, setTimeout:function(){return this;}, write:function(){}, end:function(){ doReq(u.hostname, u.pathname+u.search, 'POST', body, 0); } };
    req.on('error', e=>{ console.warn('[gsheet] sync failed:', e.message); if(cb) cb({ok:false,error:e.message}); });
    req.setTimeout(30000, ()=>req.destroy(new Error('timeout')));
    req.write(body); req.end();
  }catch(e){ console.warn('[gsheet]', e.message); if(cb) cb({ok:false,error:e.message}); }
}

router.post('/sync-now', requireAuth, requireAdmin, (req,res)=>{ syncNow(r=>res.json(r)); });

setInterval(()=>syncNow(), 3600*1000);   // hourly
setTimeout(()=>syncNow(), 20000);        // once shortly after boot
module.exports = router;
