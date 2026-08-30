// routes/backup.js — real, whole-database backup.
// The old portal "Export Full Backup" only dumped a few in-memory collections.
// This takes a consistent snapshot of the ENTIRE SQLite file (all tables,
// indexes, triggers, WAL contents) using VACUUM INTO, plus a verifiable manifest.
const router = require('express').Router();
const db     = require('../db');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { requireAuth, requireAdmin } = require('../middleware/auth');
router.use(requireAuth);

const DB_PATH  = path.join(__dirname, '..', 'agi-glass.db');
const AUTO_DIR = path.join(__dirname, '..', '_db_backups', 'auto');
function ensureDir(d){ try{ fs.mkdirSync(d,{recursive:true}); }catch(e){} }

function tableNames(){
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
           .all().map(r=>r.name);
}
function manifest(){
  const tables = tableNames().map(n=>{
    let c=0; try{ c=db.prepare('SELECT COUNT(*) c FROM "'+n+'"').get().c; }catch(e){}
    return { table:n, rows:c };
  });
  return {
    generated_at:new Date().toISOString(),
    db_file:DB_PATH,
    table_count:tables.length,
    total_rows:tables.reduce((a,t)=>a+t.rows,0),
    triggers:db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all().map(r=>r.name),
    indexes:db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='index'").get().c,
    tables
  };
}

// Consistent .db snapshot via VACUUM INTO (safe while the app is running)
function snapshot(destPath){
  if(fs.existsSync(destPath)) fs.unlinkSync(destPath);
  db.exec("VACUUM INTO '" + destPath.replace(/\\/g,'/').replace(/'/g,"''") + "'");
  const buf=fs.readFileSync(destPath);
  return { bytes:buf.length, sha256:crypto.createHash('sha256').update(buf).digest('hex') };
}

// GET /api/backup/manifest — what a backup would contain
router.get('/manifest', requireAdmin, (req,res)=>{
  try{ res.json(manifest()); }catch(e){ res.status(500).json({error:e.message}); }
});

// GET /api/backup/download — full database file
router.get('/download', requireAdmin, (req,res)=>{
  try{
    ensureDir(AUTO_DIR);
    const name='agi-glass-'+new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')+'.db';
    const tmp=path.join(AUTO_DIR,'_manual_'+name);
    const info=snapshot(tmp);
    res.setHeader('X-Backup-Bytes',info.bytes);
    res.setHeader('X-Backup-Sha256',info.sha256);
    res.download(tmp,name,()=>{ try{ fs.unlinkSync(tmp); }catch(e){} });
  }catch(e){ res.status(500).json({error:e.message}); }
});

// GET /api/backup/json — every table, enumerated dynamically (portable copy)
router.get('/json', requireAdmin, (req,res)=>{
  try{
    const out={ _format:'agi-full-json', _version:3, _exported:new Date().toISOString(), _manifest:manifest(), data:{} };
    tableNames().forEach(n=>{
      try{ out.data[n]=db.prepare('SELECT * FROM "'+n+'"').all(); }
      catch(e){ out.data[n]={ _error:e.message }; }
    });
    res.setHeader('Content-Disposition','attachment; filename="agi-glass-full-'+new Date().toISOString().slice(0,10)+'.json"');
    res.json(out);
  }catch(e){ res.status(500).json({error:e.message}); }
});

// Nightly automatic snapshot with retention
function autoBackup(){
  try{
    ensureDir(AUTO_DIR);
    const day=new Date().toISOString().slice(0,10);
    const dest=path.join(AUTO_DIR,'agi-glass-'+day+'.db');
    if(fs.existsSync(dest)) return;
    const info=snapshot(dest);
    console.log('[backup] nightly snapshot '+dest+' ('+(info.bytes/1048576).toFixed(1)+' MB)');
    const files=fs.readdirSync(AUTO_DIR).filter(f=>/^agi-glass-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
    while(files.length>30){ const old=files.shift(); try{ fs.unlinkSync(path.join(AUTO_DIR,old)); }catch(e){} }
  }catch(e){ console.warn('[backup] nightly failed:', e.message); }
}
setInterval(()=>{ const h=new Date().getHours(); if(h===2) autoBackup(); }, 30*60*1000);
setTimeout(autoBackup, 60*1000);   // one shortly after boot so there is always a recent copy

module.exports = router;
