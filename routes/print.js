// routes/print.js - network print queue + TSPL label builder
const router = require('express').Router();
const db     = require('../db');
const { requireAuth } = require('../middleware/auth');
const { PNG } = require('pngjs');

const AGENT_TOKEN = process.env.PRINT_AGENT_TOKEN || '350032a41a722be23a8c3cb9738e2ce0e3f03c0415390cd7';

// ---- table ----
try {
  db.prepare(`CREATE TABLE IF NOT EXISTS print_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label_type TEXT NOT NULL,
    ref TEXT,
    tspl TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_by TEXT,
    created_at DATETIME DEFAULT (datetime('now','localtime')),
    printed_at DATETIME,
    error_msg TEXT
  )`).run();
} catch(e){ console.error('[print] table:', e.message); }

function tsplText(v){ return String(v==null?'':v).replace(/["\r\n]/g,' ').slice(0,64); }
function tsplQR(v){ return String(v==null?'':v).replace(/["\r\n]/g,' ').slice(0,180); }

function buildRemnantTSPL(r){
  const cap = t => t ? String(t).charAt(0).toUpperCase()+String(t).slice(1) : '';
  const glass = (r.thickness||'')+'mm '+cap(r.glass_type||'glass')+' '+cap(r.color||'')+(r.pattern?('/'+r.pattern):'');
  const size  = Math.round(r.w)+' x '+Math.round(r.h)+' mm';
  const slot  = r.slot_code ? ('SLOT '+r.slot_code) : '';
  const L = [];
  L.push('SIZE 100 mm,50 mm');
  L.push('GAP 2 mm,0');
  L.push('DIRECTION 1');
  L.push('CLS');
  L.push('TEXT 20,20,"3",0,1,1,"'+tsplText(r.uid)+'"');
  L.push('TEXT 20,70,"2",0,1,1,"REM"');
  L.push('TEXT 20,110,"3",0,1,1,"'+tsplText(size)+'"');
  L.push('TEXT 20,150,"2",0,1,1,"'+tsplText(glass)+'"');
  if(slot) L.push('TEXT 20,195,"4",0,1,1,"'+tsplText(slot)+'"');
  L.push('QRCODE 470,20,M,7,A,0,"REMNANT ID:'+tsplQR(r.uid)+'"');
  L.push('PRINT 1,1');
  return L.join('\r\n')+'\r\n';
}
function buildPieceTSPL(p){
  const size = (p.w!=null&&p.h!=null) ? (Math.round(p.w)+' x '+Math.round(p.h)+' mm') : '';
  const L = [];
  L.push('SIZE 100 mm,50 mm');
  L.push('GAP 2 mm,0');
  L.push('DIRECTION 1');
  L.push('CLS');
  L.push('TEXT 20,20,"3",0,1,1,"'+tsplText(p.uid)+'"');
  if(p.order_num) L.push('TEXT 20,70,"2",0,1,1,"'+tsplText('Order '+p.order_num)+'"');
  if(size)        L.push('TEXT 20,110,"3",0,1,1,"'+tsplText(size)+'"');
  if(p.thickness) L.push('TEXT 20,150,"2",0,1,1,"'+tsplText(p.thickness+'mm '+(p.glass_type||'')+' '+(p.color||''))+'"');
  L.push('QRCODE 470,20,M,7,A,0,"PIECE ID:'+tsplQR(p.uid)+'"');
  L.push('PRINT 1,1');
  return L.join('\r\n')+'\r\n';
}

function enqueue(label_type, ref, tspl, who){
  const r = db.prepare('INSERT INTO print_jobs (label_type,ref,tspl,created_by) VALUES (?,?,?,?)')
    .run(label_type, ref||null, tspl, who||null);
  return r.lastInsertRowid;
}

// ===== CLIENT ENDPOINTS (requireAuth) =====
router.post('/remnant/:id', requireAuth, (req,res)=>{
  try{
    const r = db.prepare('SELECT * FROM remnants WHERE id=?').get(+req.params.id);
    if(!r) return res.status(404).json({error:'Remnant not found'});
    const id = enqueue('remnant', r.uid, buildRemnantTSPL(r), req.user.name);
    res.json({ ok:true, job_id:id, uid:r.uid });
  }catch(e){ res.status(500).json({error:e.message}); }
});

router.post('/remnants', requireAuth, (req,res)=>{
  try{
    const ids = Array.isArray(req.body.ids)?req.body.ids:[];
    if(!ids.length) return res.status(400).json({error:'ids[] required'});
    const jobs=[];
    for(const rid of ids){
      const r = db.prepare('SELECT * FROM remnants WHERE id=?').get(+rid);
      if(r) jobs.push(enqueue('remnant', r.uid, buildRemnantTSPL(r), req.user.name));
    }
    res.json({ ok:true, queued:jobs.length, job_ids:jobs });
  }catch(e){ res.status(500).json({error:e.message}); }
});

router.post('/raw', requireAuth, (req,res)=>{
  try{
    const { tspl, label_type, ref } = req.body;
    if(!tspl || typeof tspl!=='string') return res.status(400).json({error:'tspl string required'});
    const id = enqueue(label_type||'raw', ref||null, tspl, req.user.name);
    res.json({ ok:true, job_id:id });
  }catch(e){ res.status(500).json({error:e.message}); }
});

router.get('/status/:id', requireAuth, (req,res)=>{
  const j = db.prepare('SELECT id,status,error_msg,printed_at FROM print_jobs WHERE id=?').get(+req.params.id);
  if(!j) return res.status(404).json({error:'not found'});
  res.json(j);
});

router.get('/recent', requireAuth, (req,res)=>{
  res.json(db.prepare('SELECT id,label_type,ref,status,created_by,created_at,printed_at,error_msg FROM print_jobs ORDER BY id DESC LIMIT 50').all());
});

// ===== AGENT ENDPOINTS (agent token) =====
function agentAuth(req,res,next){
  const t = req.headers['x-agent-token'] || '';
  if(t !== AGENT_TOKEN) return res.status(401).json({error:'bad agent token'});
  next();
}

router.get('/pending', agentAuth, (req,res)=>{
  const jobs = db.prepare("SELECT id,tspl,ref,label_type FROM print_jobs WHERE status='pending' ORDER BY id ASC LIMIT 20").all();
  const claim = db.prepare("UPDATE print_jobs SET status='printing' WHERE id=? AND status='pending'");
  const out=[];
  for(const j of jobs){ if(claim.run(j.id).changes) out.push(j); }
  res.json(out);
});

router.post('/:id/done', agentAuth, (req,res)=>{
  db.prepare("UPDATE print_jobs SET status='done', printed_at=datetime('now','localtime') WHERE id=?").run(+req.params.id);
  res.json({ok:true});
});

router.post('/:id/error', agentAuth, (req,res)=>{
  db.prepare("UPDATE print_jobs SET status='error', error_msg=? WHERE id=?").run(String(req.body.error||'').slice(0,300), +req.params.id);
  res.json({ok:true});
});


// ===== IMAGE (client-rendered PNG -> TE244 BITMAP) =====
function pngToBitmapTSPL(pngB64){
  let raw = String(pngB64);
  const comma = raw.indexOf("base64,");
  if (comma !== -1) raw = raw.slice(comma + 7);
  const buf = Buffer.from(raw, "base64");
  const png = PNG.sync.read(buf);
  const W = png.width, H = png.height;
  const rowBytes = Math.ceil(W/8);
  const bmp = Buffer.alloc(rowBytes*H, 0x00);
  for(let y=0;y<H;y++){
    for(let x=0;x<W;x++){
      const i = (y*W+x)*4;
      const a = png.data[i+3];
      const lum = a < 128 ? 255 : (0.299*png.data[i] + 0.587*png.data[i+1] + 0.114*png.data[i+2]);
      if(lum >= 128){ bmp[y*rowBytes + (x>>3)] |= (0x80 >> (x&7)); }
    }
  }
  const header = ['SIZE 100 mm,50 mm','GAP 2 mm,0','DIRECTION 1','CLS'].join('\r\n')+'\r\n';
  const cmd = 'BITMAP 0,0,'+rowBytes+','+H+',0,';
  const footer = '\r\nPRINT 1,1\r\n';
  return Buffer.concat([Buffer.from(header+cmd,"binary"), bmp, Buffer.from(footer,"binary")]);
}

router.post('/image', requireAuth, (req,res)=>{
  try{
    const { png_base64, label_type, ref } = req.body;
    if(!png_base64) return res.status(400).json({error:'png_base64 required'});
    const bin = pngToBitmapTSPL(png_base64);
    const payload = 'B64:' + bin.toString('base64');
    const id = enqueue(label_type||'image', ref||null, payload, req.user.name);
    res.json({ ok:true, job_id:id });
  }catch(e){ res.status(500).json({error:e.message}); }
});

module.exports = router;
