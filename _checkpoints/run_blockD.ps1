# ============================================================================
#  BLOCK D  -  Process price book (rates + units per production process).
#  Snapshot first, then run the ADDITIVE migration (creates 1 new table and
#  seeds the 13 processes with rate=0). Touches NO existing data.
# ============================================================================
$ts    = Get-Date -Format 'yyyyMMdd-HHmmss'
$ckDir = 'C:\agi-server\_checkpoints'
New-Item -ItemType Directory -Force -Path $ckDir | Out-Null
$snap  = Join-Path $ckDir "agi-glass_preD_$ts.db"

$snapjs = @'
const Database=require('C:\\agi-server\\node_modules\\better-sqlite3');
const dest=process.argv[2];
const db=new Database('C:\\agi-server\\agi-glass.db',{readonly:true});
db.backup(dest).then(()=>{const v=new Database(dest,{readonly:true});console.log('pre-D snapshot OK -> '+dest+'  (order_items='+v.prepare('SELECT COUNT(*) c FROM order_items').get().c+', products='+v.prepare('SELECT COUNT(*) c FROM products').get().c+')');v.close();db.close();}).catch(e=>{console.error('SNAP FAIL',e.message);process.exit(1);});
'@
$st = Join-Path $env:TEMP 'agi_snapD.js'
Set-Content -Path $st -Value $snapjs -Encoding ascii
node $st $snap
Remove-Item $st

$blockD = @'
// ===========================================================================
// BLOCK D  -  Process price book (rates + units per production process).
// ADDITIVE: creates 1 new table, seeds the 13 processes (rate=0 = unset).
// Touches NO existing data. value_extras stays 0 until Block E + rates.
// Idempotent: re-run never overwrites rates you have already set
// (INSERT OR IGNORE on process_code).
// Revert = DROP TABLE process_pricing.
// ===========================================================================
const DBPATH = 'C:\\agi-server\\agi-glass.db';
const Database = require('C:\\agi-server\\node_modules\\better-sqlite3');
const db = new Database(DBPATH);

db.exec(`
CREATE TABLE IF NOT EXISTS process_pricing(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  process_code TEXT NOT NULL UNIQUE,
  label_en TEXT,
  unit TEXT NOT NULL,           -- per_sqm | per_meter | per_hole | per_cutout | per_piece | flat
  rate REAL DEFAULT 0,          -- JD per unit (0 = unset; to be filled in)
  min_charge REAL DEFAULT 0,    -- optional per-process minimum
  param_field TEXT,             -- numeric driver: bevelMM | drillCount | cutoutCount
  active INTEGER DEFAULT 1,
  sort_order INTEGER DEFAULT 0,
  notes TEXT,
  updated_at DATETIME
);
`);

// Seed: code, label, unit, param_field  (mirrors frontend PROCS order)
const SEED = [
  ['cutting',     'Cutting',      'per_sqm',    null],
  ['arrising',    'Arrising',     'per_meter',  null],
  ['flat',        'Flat Polish',  'per_meter',  null],
  ['round',       'Round Polish', 'per_meter',  null],
  ['bevel',       'Bevel',        'per_meter',  'bevelMM'],
  ['drilling',    'Drilling',     'per_hole',   'drillCount'],
  ['cutouts',     'Cut-outs',     'per_cutout', 'cutoutCount'],
  ['tempering',   'Tempering',    'per_sqm',    null],
  ['laminating',  'Laminating',   'per_sqm',    null],
  ['paint',       'Paint',        'per_sqm',    null],
  ['sandblasting','Sand Blast',   'per_sqm',    null],
  ['poly',        'Poly',         'per_sqm',    null],
  ['igu',         'IGU',          'per_sqm',    null],
];
const ins = db.prepare('INSERT OR IGNORE INTO process_pricing(process_code,label_en,unit,param_field,sort_order) VALUES(?,?,?,?,?)');
const seedTx = db.transaction(() => { SEED.forEach((r,i)=>ins.run(r[0],r[1],r[2],r[3],i)); });
seedTx();

// \u2500\u2500 VERIFY \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
const codes = new Set(db.prepare('SELECT process_code FROM process_pricing').all().map(r=>r.process_code));
// scan real order_items.processes for any process not in the price book
let scanned=0; const usage={}; const orphanProcs=new Set();
let hasCol = true;
try {
  const items = db.prepare('SELECT processes FROM order_items').all();
  for (const it of items){
    scanned++;
    let procs = it.processes;
    if (typeof procs==='string'){ try{ procs=JSON.parse(procs); }catch(e){ procs=[]; } }
    if (Array.isArray(procs)) for (const p of procs){
      const id = (p && typeof p==='object') ? (p.id||p.name||p.proc) : p;
      if (id==null) continue;
      usage[id]=(usage[id]||0)+1;
      if (!codes.has(String(id))) orphanProcs.add(String(id));
    }
  }
} catch(e){ hasCol=false; }

const total = db.prepare('SELECT COUNT(*) c FROM process_pricing').get().c;
const unset = db.prepare('SELECT COUNT(*) c FROM process_pricing WHERE rate=0 OR rate IS NULL').get().c;
console.log('=== BLOCK D PRICE BOOK ===');
console.log('process_pricing rows:', total, '(expected 13)');
console.log('order_items scanned:', scanned);
console.log('process usage (real):', JSON.stringify(usage));
console.log('orphan processes (used but not in price book):', orphanProcs.size, JSON.stringify([...orphanProcs]), '(must be 0)');
console.log('rows with unset rate (rate=0):', unset, '(fill these in next)');
console.log('RESULT:', (total>=13 && orphanProcs.size===0) ? 'PASS - price book ready; rates pending' : 'FAIL - review above');
db.close();

'@
$djs = Join-Path $ckDir 'blockD.js'
Set-Content -Path $djs -Value $blockD -Encoding ascii

Write-Host "`n--- Running Block D migration ---"
node $djs
Write-Host "`nMigration script saved at: $djs"
Write-Host "REVERT (only if needed): node -e `"const d=require('C:\\agi-server\\node_modules\\better-sqlite3')('C:\\agi-server\\agi-glass.db');d.exec('DROP TABLE IF EXISTS process_pricing;');console.log('Block D reverted');`""
