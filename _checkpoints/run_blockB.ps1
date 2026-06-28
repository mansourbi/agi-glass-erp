# ============================================================================
#  BLOCK B  -  Products model (header + layers + components), ID-linked.
#  Snapshot first, then run the ADDITIVE migration (creates 3 new tables and
#  migrates final_products via the Block A bridge). Touches NO existing data.
# ============================================================================
$ts    = Get-Date -Format 'yyyyMMdd-HHmmss'
$ckDir = 'C:\agi-server\_checkpoints'
New-Item -ItemType Directory -Force -Path $ckDir | Out-Null
$snap  = Join-Path $ckDir "agi-glass_preB_$ts.db"

# 1) consistent pre-block snapshot (no downtime)
$snapjs = @'
const Database=require('C:\\agi-server\\node_modules\\better-sqlite3');
const dest=process.argv[2];
const db=new Database('C:\\agi-server\\agi-glass.db',{readonly:true});
db.backup(dest).then(()=>{const v=new Database(dest,{readonly:true});console.log('pre-B snapshot OK -> '+dest+'  (final_products='+v.prepare('SELECT COUNT(*) c FROM final_products').get().c+', attribute_values='+v.prepare('SELECT COUNT(*) c FROM attribute_values').get().c+')');v.close();db.close();}).catch(e=>{console.error('SNAP FAIL',e.message);process.exit(1);});
'@
$st = Join-Path $env:TEMP 'agi_snapB.js'
Set-Content -Path $st -Value $snapjs -Encoding ascii
node $st $snap
Remove-Item $st

# 2) write the Block B migration script (pure ASCII; Arabic token as \u escape)
$blockB = @'
// ===========================================================================
// BLOCK B  \u2014  Products model (header + layers + components), ID-linked.
// ADDITIVE: creates 3 new tables, migrates final_products via the Block A
// bridge. Touches NO existing data (final_products/orders untouched).
// Idempotent: re-running skips already-migrated final_products.
// Revert = drop the 3 new tables (command printed at end).
// ===========================================================================
const DBPATH = 'C:\\agi-server\\agi-glass.db';
const Database = require('C:\\agi-server\\node_modules\\better-sqlite3');
const db = new Database(DBPATH);
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS products(
  id INTEGER PRIMARY KEY AUTOINCREMENT, legacy_fp_id INTEGER, serial TEXT, label TEXT,
  category_value_id INTEGER REFERENCES attribute_values(id),
  family_value_id INTEGER REFERENCES attribute_values(id), kind TEXT DEFAULT 'monolithic',
  edge_value_id INTEGER REFERENCES attribute_values(id), bevel_size_mm REAL, raw_edge TEXT,
  process_value_id INTEGER REFERENCES attribute_values(id),
  tempered_value_id INTEGER REFERENCES attribute_values(id),
  paint_color_value_id INTEGER REFERENCES attribute_values(id),
  brand_value_id INTEGER REFERENCES attribute_values(id),
  origin_value_id INTEGER REFERENCES attribute_values(id), antique_code TEXT,
  is_ujoor INTEGER DEFAULT 0, general_price_sqm REAL, active INTEGER DEFAULT 1,
  sort_order INTEGER DEFAULT 0, spec_key TEXT, notes TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS product_layers(
  id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL REFERENCES products(id),
  layer_index INTEGER NOT NULL, role TEXT NOT NULL,
  family_value_id INTEGER REFERENCES attribute_values(id),
  color_value_id INTEGER REFERENCES attribute_values(id),
  pattern_value_id INTEGER REFERENCES attribute_values(id),
  thickness_mm REAL, interlayer_type TEXT, UNIQUE(product_id, layer_index));
CREATE TABLE IF NOT EXISTS product_components(
  id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL REFERENCES products(id),
  component_type TEXT, ref_value_id INTEGER REFERENCES attribute_values(id), detail TEXT, qty REAL);
`);

const ANT_AR = '\u0627\u0646\u062a\u064a\u0643'; // \u0627\u0646\u062a\u064a\u0643
const qAlias = db.prepare('SELECT value_id FROM attribute_value_aliases WHERE legacy_field=? AND alias=?');
const qVinfo = db.prepare('SELECT av.code vc, a.code ax FROM attribute_values av JOIN attributes a ON a.id=av.attribute_id WHERE av.id=?');
const qByCode = db.prepare('SELECT av.id id FROM attribute_values av JOIN attributes a ON a.id=av.attribute_id WHERE a.code=? AND av.code=?');
function byCode(axis, code){ const r=qByCode.get(axis,code); return r?r.id:null; }
function resolve(field, val){
  if(val==null) return null;
  const raw=String(val).trim(); if(raw==='') return null;
  const s=raw.toLowerCase();
  if((field==='color'||field==='fp_glass_type'||field==='family') && (s.startsWith('antique')||raw.startsWith(ANT_AR))){
    let code=raw;
    if(s.startsWith('antique')) code=raw.slice(7).trim();
    else if(raw.startsWith(ANT_AR)) code=raw.slice(ANT_AR.length).trim();
    return {vid:byCode('family','antique'), axis:'family', code:'antique', antique_code: code||null};
  }
  const r=qAlias.get(field,s);
  if(!r) return {vid:null, axis:null, code:null, orphan:raw};
  const vi=qVinfo.get(r.value_id);
  return {vid:r.value_id, axis:vi?vi.ax:null, code:vi?vi.vc:null};
}
function bevelMm(edgeRaw){ if(!edgeRaw) return null; const m=String(edgeRaw).match(/(\d+(?:\.\d+)?)/); return m?parseFloat(m[1])*10:null; }
function decodeThickness(th){
  const s=String(th==null?'':th).trim();
  if(s.indexOf('+')<0){ const n=parseFloat(s); return {layers:[{role:'glass',t:isNaN(n)?null:n}], kind:'monolithic'}; }
  const nums=s.split('+').map(p=>{const n=parseFloat(p.trim()); return isNaN(n)?null:n;});
  let layers;
  if(nums.length===2){ layers=[{role:'glass',t:nums[0]},{role:'interlayer',t:null},{role:'glass',t:nums[1]}]; }
  else { layers=nums.map((n,i)=>({role:(i%2===0)?'glass':'interlayer', t:n})); }
  return {layers, kind:'laminated'};
}

const insP = db.prepare(`INSERT INTO products(legacy_fp_id,serial,label,category_value_id,family_value_id,kind,
  edge_value_id,bevel_size_mm,raw_edge,process_value_id,tempered_value_id,paint_color_value_id,
  brand_value_id,origin_value_id,antique_code,is_ujoor,general_price_sqm,sort_order,spec_key)
  VALUES(@legacy_fp_id,@serial,@label,@category_value_id,@family_value_id,@kind,@edge_value_id,@bevel_size_mm,@raw_edge,
  @process_value_id,@tempered_value_id,@paint_color_value_id,@brand_value_id,@origin_value_id,@antique_code,@is_ujoor,@general_price_sqm,@sort_order,@spec_key)`);
const insGlass = db.prepare('INSERT INTO product_layers(product_id,layer_index,role,family_value_id,color_value_id,pattern_value_id,thickness_mm) VALUES(?,?,?,?,?,?,?)');
const insInter = db.prepare('INSERT INTO product_layers(product_id,layer_index,role,thickness_mm,interlayer_type) VALUES(?,?,?,?,?)');

const done = new Set(db.prepare('SELECT legacy_fp_id FROM products WHERE legacy_fp_id IS NOT NULL').all().map(r=>r.legacy_fp_id));
const fps = db.prepare('SELECT id,label,category,subtype,thickness,glass_type,color,tempered,edge,process,paint_color,brand,origin,is_ujoor,general_price_sqm,serial,sort_order FROM final_products ORDER BY id').all();

const orphans = [];
let migrated=0, skipped=0;
const run = db.transaction(() => {
  for(const fp of fps){
    if(done.has(fp.id)){ skipped++; continue; }
    const cat=resolve('category',fp.category), gt=resolve('fp_glass_type',fp.glass_type), col=resolve('color',fp.color);
    const edge=resolve('edge',fp.edge), temp=resolve('tempered',fp.tempered), proc=resolve('process',fp.process);
    const paint=resolve('paint_color',fp.paint_color), brand=resolve('brand',fp.brand), orig=resolve('origin',fp.origin);
    [['category',cat],['color',col],['edge',edge]].forEach(([nm,rr])=>{ if(rr&&rr.orphan) orphans.push([fp.id,nm,rr.orphan]); });

    let family_vid=null, pattern_vid=null, color_vid=null, antique_code=null;
    if(col && col.axis==='family' && col.code==='antique'){ family_vid=col.vid; antique_code=col.antique_code||null; }
    else if(col && col.axis==='color'){ color_vid=col.vid; }
    if(gt){
      if(gt.axis==='pattern'){ pattern_vid=gt.vid; if(family_vid==null) family_vid=byCode('family','patterned'); }
      else if(gt.axis==='family'){ if(family_vid==null) family_vid=gt.vid; }
    }
    const catCode = cat?cat.code:null;
    if(family_vid==null && catCode==='glass'){ family_vid=byCode('family','float'); } // ASSUMPTION: plain glass = Float; plain mirror stays NULL

    const dec=decodeThickness(fp.thickness);
    const bsz=(edge && edge.code==='bevel') ? bevelMm(fp.edge) : null;
    const spec=['c'+(cat?cat.vid:''),'f'+(family_vid||''),'col'+(color_vid||''),'p'+(pattern_vid||''),'th'+(fp.thickness||''),'e'+(edge?edge.vid:''),'a'+(antique_code||'')].join('|');

    const info=insP.run({legacy_fp_id:fp.id, serial:fp.serial, label:fp.label,
      category_value_id:cat?cat.vid:null, family_value_id:family_vid, kind:dec.kind,
      edge_value_id:edge?edge.vid:null, bevel_size_mm:bsz, raw_edge:fp.edge||null,
      process_value_id:proc?proc.vid:null, tempered_value_id:temp?temp.vid:null, paint_color_value_id:paint?paint.vid:null,
      brand_value_id:brand?brand.vid:null, origin_value_id:orig?orig.vid:null, antique_code:antique_code,
      is_ujoor:fp.is_ujoor?1:0, general_price_sqm:fp.general_price_sqm, sort_order:fp.sort_order||0, spec_key:spec});
    const pid=info.lastInsertRowid;
    let li=0;
    for(const L of dec.layers){
      if(L.role==='glass') insGlass.run(pid, li, 'glass', family_vid, color_vid, pattern_vid, L.t);
      else insInter.run(pid, li, 'interlayer', L.t, 'PVB');
      li++;
    }
    migrated++;
  }
});
run();

// \u2500\u2500 VERIFY \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
const nfp=db.prepare('SELECT COUNT(*) c FROM final_products').get().c;
const npr=db.prepare('SELECT COUNT(*) c FROM products').get().c;
const noCat=db.prepare('SELECT COUNT(*) c FROM products WHERE category_value_id IS NULL').get().c;
const noLayer=db.prepare("SELECT COUNT(*) c FROM products p WHERE NOT EXISTS(SELECT 1 FROM product_layers l WHERE l.product_id=p.id AND l.role='glass')").get().c;
const lost=db.prepare(`SELECT COUNT(*) c FROM products p WHERE p.family_value_id IS NULL AND p.antique_code IS NULL
   AND NOT EXISTS(SELECT 1 FROM product_layers l WHERE l.product_id=p.id AND (l.color_value_id IS NOT NULL OR l.pattern_value_id IS NOT NULL))`).get().c;
const lam=db.prepare("SELECT COUNT(*) c FROM products WHERE kind='laminated'").get().c;
const ant=db.prepare('SELECT legacy_fp_id, antique_code FROM products WHERE antique_code IS NOT NULL').all();
const bev=db.prepare('SELECT legacy_fp_id, bevel_size_mm, raw_edge FROM products WHERE bevel_size_mm IS NOT NULL ORDER BY legacy_fp_id').all();
console.log('=== BLOCK B MIGRATION VERIFY ===');
console.log('migrated='+migrated+'  skipped(already done)='+skipped);
console.log('final_products='+nfp+'  products='+npr);
console.log('products missing category:', noCat, '(must be 0)');
console.log('products missing glass layer:', noLayer, '(must be 0)');
console.log('products with no family/color/pattern/antique:', lost, '(must be 0)');
console.log('orphan attribute values:', orphans.length, JSON.stringify(orphans));
console.log('laminated products:', lam, '(0 expected on current data)');
console.log('antique_code captured:', JSON.stringify(ant));
console.log('bevel sizes:', JSON.stringify(bev));
const pass = (noCat===0 && noLayer===0 && lost===0 && orphans.length===0 && (migrated+skipped)===nfp);
console.log('RESULT:', pass ? 'PASS - all final_products migrated and resolved' : 'FAIL - review above (nothing existing was modified)');
db.close();

'@
$bjs = Join-Path $ckDir 'blockB.js'
Set-Content -Path $bjs -Value $blockB -Encoding ascii

# 3) run it
Write-Host "`n--- Running Block B migration ---"
node $bjs
Write-Host "`nMigration script saved at: $bjs"
Write-Host "REVERT (only if needed): node -e `"const d=require('C:\\agi-server\\node_modules\\better-sqlite3')('C:\\agi-server\\agi-glass.db');d.exec('DROP TABLE IF EXISTS product_components;DROP TABLE IF EXISTS product_layers;DROP TABLE IF EXISTS products;');console.log('Block B reverted');`""
