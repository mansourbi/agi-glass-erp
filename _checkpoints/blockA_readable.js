// ===========================================================================
// BLOCK A  —  Catalog normalization (ID-based attributes + alias bridge)
// ADDITIVE ONLY: creates 3 new tables, reads 5 existing tables read-only.
// Touches NO existing data. Revert = drop the 3 new tables.
// Idempotent: re-running is safe (INSERT OR IGNORE on UNIQUE keys).
// ===========================================================================
const DBPATH = 'C:\\agi-server\\agi-glass.db';
const Database = require('C:\\agi-server\\node_modules\\better-sqlite3');
const db = new Database(DBPATH);
db.pragma('foreign_keys = ON');

// ── 1. Tables (additive) ───────────────────────────────────────────────────
db.exec(`
CREATE TABLE IF NOT EXISTS attributes(
  id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE,
  label_en TEXT NOT NULL, label_ar TEXT, nullable INTEGER DEFAULT 1,
  has_free_text INTEGER DEFAULT 0, sort_order INTEGER DEFAULT 0, active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS attribute_values(
  id INTEGER PRIMARY KEY AUTOINCREMENT, attribute_id INTEGER NOT NULL REFERENCES attributes(id),
  code TEXT NOT NULL, label_en TEXT NOT NULL, label_ar TEXT,
  sort_order INTEGER DEFAULT 0, active INTEGER DEFAULT 1, UNIQUE(attribute_id,code));
CREATE TABLE IF NOT EXISTS attribute_value_aliases(
  id INTEGER PRIMARY KEY AUTOINCREMENT, legacy_field TEXT NOT NULL, alias TEXT NOT NULL,
  value_id INTEGER NOT NULL REFERENCES attribute_values(id), note TEXT, UNIQUE(legacy_field,alias));
`);

// ── 2. Seed data ────────────────────────────────────────────────────────────
const ATTRS = [
  ['category','Category','الصنف',0,0],
  ['family','Family','العائلة',1,0],
  ['color','Color','اللون',1,0],
  ['pattern','Pattern','النقشة',1,1],
  ['thickness','Thickness','السماكة',0,0],
  ['edge','Edge','الحرف',1,0],
  ['process','Process','المعالجة',1,0],
  ['paint_color','Paint Color','لون الدهان',1,0],
  ['tempered','Tempered','سيكوريت',1,0],
  ['brand','Brand (Manufacturer)','المصنّع',1,0],
  ['origin','Origin','المنشأ',1,0],
];
const VALUES = {
  category:[['glass','Glass','زجاج'],['mirror','Mirror','مرايا']],
  family:[['float','Float','فلوت'],['patterned','Patterned','مبزر'],['tinted','Tinted','فيميه'],['reflective','Reflective','عاكس'],['antique','Antique','انتيك']],
  color:[['clear','Clear','سادة'],['low_iron','Low-Iron','كرستال'],['bronze','Bronze','برونز'],['grey','Grey','رمادي'],['green','Green','أخضر'],['blue','Blue','أزرق'],['black','Black','اسود'],['silver','Silver','فضي']],
  pattern:[['fluted','Fluted','فلوتد']],
  thickness:[['4','4mm','4'],['5','5mm','5'],['5.5','5.5mm','5.5'],['6','6mm','6'],['8','8mm','8'],['10','10mm','10'],['12','12mm','12'],['15','15mm','15']],
  edge:[['square','Square','مربع'],['pencil','Pencil','مبروم'],['ground','Ground','حف'],['bevel','Bevel','شطف']],
  process:[['ceramic_paint','Ceramic Paint','مدهون سيراميك'],['cold_paint','Cold Paint','مدهون بارد'],['sandblasted','Sandblasted','مغشى رمل'],['film','Film','فيلم'],['frosted_ceramic','Frosted Ceramic','فروستيد سيراميك']],
  paint_color:[['black','Black','اسود'],['white','White','ابيض'],['grey','Grey','رمادي'],['milky','Milky','حليبي']],
  tempered:[['tempered','Tempered','سيكوريت'],['not_tempered','Not Tempered','بدون سيكوريت']],
  brand:[['agc','AGC','AGC'],['obeikan','Obeikan','عبيكان'],['saint_gobain','Saint-Gobain','سان جوبان'],['guardian','Guardian','جوارديان'],['qingdao_jinjing','Qingdao Jinjing','تشينغداو'],['xyg','XYG','XYG'],['jingrun','Jingrun','جينغرون'],['qin','QIN','QIN'],['jin','JIN','JIN']],
  origin:[['china','China','صيني'],['belgium','Belgium','بلجيكي'],['ksa','KSA','السعودية'],['jordan','Jordan','الأردن']],
};
const ALIASES = [
  ['category',['glass','زجاج'],'category','glass'],
  ['category',['mirror','مرايا'],'category','mirror'],
  ['color',['clear','سادة'],'color','clear'],
  ['color',['low-iron','كرستال','crystal'],'color','low_iron'],
  ['color',['bronze','برونز'],'color','bronze'],
  ['color',['grey','رمادي'],'color','grey'],
  ['color',['green'],'color','green'],
  ['color',['blue'],'color','blue'],
  ['color',['black','اسود'],'color','black'],
  ['color',['silver'],'color','silver'],
  ['color',['antique','انتيك'],'family','antique'],   // cross-axis: antique stored as color -> Family
  ['fp_glass_type',['فلوتد'],'pattern','fluted'],
  ['fp_glass_type',['مبزر'],'family','patterned'],
  ['fp_glass_type',['فيميه'],'family','tinted'],
  ['edge',['مربع'],'edge','square'],
  ['edge',['مبروم'],'edge','pencil'],
  ['edge',['حف'],'edge','ground'],
  ['edge',['شطف','شطف 1سم','شطف 2سم','شطف 2.5','شطف1سم+مربع'],'edge','bevel'],
  ['process',['مدهون سيراميك'],'process','ceramic_paint'],
  ['process',['مدهون بارد'],'process','cold_paint'],
  ['process',['مغشى رمل'],'process','sandblasted'],
  ['process',['فيلم'],'process','film'],
  ['process',['فروستيد سيراميك'],'process','frosted_ceramic'],
  ['paint_color',['اسود'],'paint_color','black'],
  ['paint_color',['ابيض'],'paint_color','white'],
  ['paint_color',['رمادي'],'paint_color','grey'],
  ['paint_color',['حليبي'],'paint_color','milky'],
  ['tempered',['سيكوريت'],'tempered','tempered'],
  ['tempered',['بدون سيكوريت'],'tempered','not_tempered'],
  ['brand',['agc'],'brand','agc'],
  ['brand',['obeikan','obk','عبيكان'],'brand','obeikan'],
  ['brand',['سان جوبان','saint-gobain','saint gobain'],'brand','saint_gobain'],
  ['brand',['guardian'],'brand','guardian'],
  ['brand',['qingdao jinjing'],'brand','qingdao_jinjing'],
  ['brand',['xyg'],'brand','xyg'],
  ['brand',['jingrun'],'brand','jingrun'],
  ['brand',['qin'],'brand','qin'],
  ['brand',['jin'],'brand','jin'],
  ['origin',['china','صيني'],'origin','china'],
  ['origin',['belgium','بلجيكي'],'origin','belgium'],
  ['origin',['ksa'],'origin','ksa'],
  ['origin',['jordan'],'origin','jordan'],
  ['thickness',['4'],'thickness','4'],['thickness',['5'],'thickness','5'],['thickness',['5.5'],'thickness','5.5'],
  ['thickness',['6'],'thickness','6'],['thickness',['8'],'thickness','8'],['thickness',['10'],'thickness','10'],
  ['thickness',['12'],'thickness','12'],['thickness',['15'],'thickness','15'],
];

const seed = db.transaction(() => {
  const insA = db.prepare('INSERT OR IGNORE INTO attributes(code,label_en,label_ar,nullable,has_free_text,sort_order) VALUES(?,?,?,?,?,?)');
  ATTRS.forEach((a,i)=>insA.run(a[0],a[1],a[2],a[3],a[4],i));
  const A={}; db.prepare('SELECT code,id FROM attributes').all().forEach(r=>A[r.code]=r.id);
  const insV = db.prepare('INSERT OR IGNORE INTO attribute_values(attribute_id,code,label_en,label_ar,sort_order) VALUES(?,?,?,?,?)');
  Object.keys(VALUES).forEach(ax=>VALUES[ax].forEach((v,i)=>insV.run(A[ax],v[0],v[1],v[2],i)));
  const vid={}; db.prepare('SELECT av.id,av.code,a.code axis FROM attribute_values av JOIN attributes a ON a.id=av.attribute_id').all().forEach(r=>vid[r.axis+'|'+r.code]=r.id);
  const insAl = db.prepare('INSERT OR IGNORE INTO attribute_value_aliases(legacy_field,alias,value_id,note) VALUES(?,?,?,?)');
  ALIASES.forEach(([field,strs,axis,code])=>{
    const id=vid[axis+'|'+code];
    strs.forEach(s=>insAl.run(field,String(s).trim().toLowerCase(),id, axis!==field?('canonical axis: '+axis):null));
  });
  return {A,vid};
});
const {vid} = seed();
const ANT = vid['family|antique'];

// ── 3. Verifier (read-only) ─────────────────────────────────────────────────
const lookAlias = db.prepare('SELECT value_id FROM attribute_value_aliases WHERE legacy_field=? AND alias=?');
function resolve(field, val){
  if(val==null) return {st:'NULL'};
  const raw=String(val).trim(); if(raw==='') return {st:'EMPTY'};
  const s=raw.toLowerCase();
  if((field==='color'||field==='fp_glass_type'||field==='family') && (s.startsWith('antique')||raw.startsWith('انتيك')))
    return {st:'OK',vid:ANT};
  const r=lookAlias.get(field,s);
  return r?{st:'OK',vid:r.value_id}:{st:'ORPHAN'};
}
function distinct(tbl,col){ try{return db.prepare(`SELECT ${col} v, COUNT(*) n FROM ${tbl} GROUP BY ${col}`).all();}catch(e){return [{v:'__ERR__:'+e.message,n:0}];} }

const DATA = [
  ['final_products','category','category'],['final_products','color','color'],
  ['final_products','glass_type','fp_glass_type'],['final_products','edge','edge'],
  ['raw_sheets','glass_type','category'],['raw_sheets','color','color'],
  ['order_items','glass_type','category'],['order_items','color','color'],
  ['glass_families','type','category'],['glass_families','color','color'],
];
console.log('=== DATA-TABLE RESOLUTION (must be 0 orphans) ===');
let dataOrphans=0;
for(const [tbl,col,field] of DATA){
  for(const {v,n} of distinct(tbl,col)){
    const r=resolve(field,v);
    if(r.st==='ORPHAN'){ dataOrphans++; console.log(`  [ORPHAN] ${tbl}.${col} = "${v}" (x${n})  field=${field}`); }
  }
}
console.log('  data-table orphans:', dataOrphans);

const FM={category:'category',color:'color',glass_type:'fp_glass_type',edge:'edge',process:'process',paint_color:'paint_color',brand:'brand',tempered:'tempered',origin:'origin',thickness:'thickness'};
console.log('\n=== fp_field_values dropdown leftovers (informational) ===');
let leftovers=0;
try{
  for(const {field_name,value} of db.prepare('SELECT field_name,value FROM fp_field_values').all()){
    const field=FM[field_name]; if(!field) continue;
    if(resolve(field,value).st==='ORPHAN'){ leftovers++; const eng=[...String(value)].every(ch=>ch.charCodeAt(0)<128); console.log(`  [leftover] ${field_name} = "${value}"${eng?' (unused english seed / laminated composite)':''}`); }
  }
}catch(e){ console.log('  (fp_field_values read error: '+e.message+')'); }
console.log('  dropdown leftovers:', leftovers);

const cnt = db.prepare('SELECT (SELECT COUNT(*) FROM attributes) a,(SELECT COUNT(*) FROM attribute_values) v,(SELECT COUNT(*) FROM attribute_value_aliases) al').get();
console.log(`\nSeeded: attributes=${cnt.a}  values=${cnt.v}  aliases=${cnt.al}`);
console.log('RESULT:', dataOrphans===0 ? 'PASS — every data value resolves to a canonical id' : 'FAIL — data orphans exist (tell Claude; nothing existing was modified)');
db.close();
