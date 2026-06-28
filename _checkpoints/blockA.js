// ===========================================================================
// BLOCK A  \u2014  Catalog normalization (ID-based attributes + alias bridge)
// ADDITIVE ONLY: creates 3 new tables, reads 5 existing tables read-only.
// Touches NO existing data. Revert = drop the 3 new tables.
// Idempotent: re-running is safe (INSERT OR IGNORE on UNIQUE keys).
// ===========================================================================
const DBPATH = 'C:\\agi-server\\agi-glass.db';
const Database = require('C:\\agi-server\\node_modules\\better-sqlite3');
const db = new Database(DBPATH);
db.pragma('foreign_keys = ON');

// \u2500\u2500 1. Tables (additive) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
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

// \u2500\u2500 2. Seed data \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
const ATTRS = [
  ['category','Category','\u0627\u0644\u0635\u0646\u0641',0,0],
  ['family','Family','\u0627\u0644\u0639\u0627\u0626\u0644\u0629',1,0],
  ['color','Color','\u0627\u0644\u0644\u0648\u0646',1,0],
  ['pattern','Pattern','\u0627\u0644\u0646\u0642\u0634\u0629',1,1],
  ['thickness','Thickness','\u0627\u0644\u0633\u0645\u0627\u0643\u0629',0,0],
  ['edge','Edge','\u0627\u0644\u062d\u0631\u0641',1,0],
  ['process','Process','\u0627\u0644\u0645\u0639\u0627\u0644\u062c\u0629',1,0],
  ['paint_color','Paint Color','\u0644\u0648\u0646 \u0627\u0644\u062f\u0647\u0627\u0646',1,0],
  ['tempered','Tempered','\u0633\u064a\u0643\u0648\u0631\u064a\u062a',1,0],
  ['brand','Brand (Manufacturer)','\u0627\u0644\u0645\u0635\u0646\u0651\u0639',1,0],
  ['origin','Origin','\u0627\u0644\u0645\u0646\u0634\u0623',1,0],
];
const VALUES = {
  category:[['glass','Glass','\u0632\u062c\u0627\u062c'],['mirror','Mirror','\u0645\u0631\u0627\u064a\u0627']],
  family:[['float','Float','\u0641\u0644\u0648\u062a'],['patterned','Patterned','\u0645\u0628\u0632\u0631'],['tinted','Tinted','\u0641\u064a\u0645\u064a\u0647'],['reflective','Reflective','\u0639\u0627\u0643\u0633'],['antique','Antique','\u0627\u0646\u062a\u064a\u0643']],
  color:[['clear','Clear','\u0633\u0627\u062f\u0629'],['low_iron','Low-Iron','\u0643\u0631\u0633\u062a\u0627\u0644'],['bronze','Bronze','\u0628\u0631\u0648\u0646\u0632'],['grey','Grey','\u0631\u0645\u0627\u062f\u064a'],['green','Green','\u0623\u062e\u0636\u0631'],['blue','Blue','\u0623\u0632\u0631\u0642'],['black','Black','\u0627\u0633\u0648\u062f'],['silver','Silver','\u0641\u0636\u064a']],
  pattern:[['fluted','Fluted','\u0641\u0644\u0648\u062a\u062f']],
  thickness:[['4','4mm','4'],['5','5mm','5'],['5.5','5.5mm','5.5'],['6','6mm','6'],['8','8mm','8'],['10','10mm','10'],['12','12mm','12'],['15','15mm','15']],
  edge:[['square','Square','\u0645\u0631\u0628\u0639'],['pencil','Pencil','\u0645\u0628\u0631\u0648\u0645'],['ground','Ground','\u062d\u0641'],['bevel','Bevel','\u0634\u0637\u0641']],
  process:[['ceramic_paint','Ceramic Paint','\u0645\u062f\u0647\u0648\u0646 \u0633\u064a\u0631\u0627\u0645\u064a\u0643'],['cold_paint','Cold Paint','\u0645\u062f\u0647\u0648\u0646 \u0628\u0627\u0631\u062f'],['sandblasted','Sandblasted','\u0645\u063a\u0634\u0649 \u0631\u0645\u0644'],['film','Film','\u0641\u064a\u0644\u0645'],['frosted_ceramic','Frosted Ceramic','\u0641\u0631\u0648\u0633\u062a\u064a\u062f \u0633\u064a\u0631\u0627\u0645\u064a\u0643']],
  paint_color:[['black','Black','\u0627\u0633\u0648\u062f'],['white','White','\u0627\u0628\u064a\u0636'],['grey','Grey','\u0631\u0645\u0627\u062f\u064a'],['milky','Milky','\u062d\u0644\u064a\u0628\u064a']],
  tempered:[['tempered','Tempered','\u0633\u064a\u0643\u0648\u0631\u064a\u062a'],['not_tempered','Not Tempered','\u0628\u062f\u0648\u0646 \u0633\u064a\u0643\u0648\u0631\u064a\u062a']],
  brand:[['agc','AGC','AGC'],['obeikan','Obeikan','\u0639\u0628\u064a\u0643\u0627\u0646'],['saint_gobain','Saint-Gobain','\u0633\u0627\u0646 \u062c\u0648\u0628\u0627\u0646'],['guardian','Guardian','\u062c\u0648\u0627\u0631\u062f\u064a\u0627\u0646'],['qingdao_jinjing','Qingdao Jinjing','\u062a\u0634\u064a\u0646\u063a\u062f\u0627\u0648'],['xyg','XYG','XYG'],['jingrun','Jingrun','\u062c\u064a\u0646\u063a\u0631\u0648\u0646'],['qin','QIN','QIN'],['jin','JIN','JIN']],
  origin:[['china','China','\u0635\u064a\u0646\u064a'],['belgium','Belgium','\u0628\u0644\u062c\u064a\u0643\u064a'],['ksa','KSA','\u0627\u0644\u0633\u0639\u0648\u062f\u064a\u0629'],['jordan','Jordan','\u0627\u0644\u0623\u0631\u062f\u0646']],
};
const ALIASES = [
  ['category',['glass','\u0632\u062c\u0627\u062c'],'category','glass'],
  ['category',['mirror','\u0645\u0631\u0627\u064a\u0627'],'category','mirror'],
  ['color',['clear','\u0633\u0627\u062f\u0629'],'color','clear'],
  ['color',['low-iron','\u0643\u0631\u0633\u062a\u0627\u0644','crystal'],'color','low_iron'],
  ['color',['bronze','\u0628\u0631\u0648\u0646\u0632'],'color','bronze'],
  ['color',['grey','\u0631\u0645\u0627\u062f\u064a'],'color','grey'],
  ['color',['green'],'color','green'],
  ['color',['blue'],'color','blue'],
  ['color',['black','\u0627\u0633\u0648\u062f'],'color','black'],
  ['color',['silver'],'color','silver'],
  ['color',['antique','\u0627\u0646\u062a\u064a\u0643'],'family','antique'],   // cross-axis: antique stored as color -> Family
  ['fp_glass_type',['\u0641\u0644\u0648\u062a\u062f'],'pattern','fluted'],
  ['fp_glass_type',['\u0645\u0628\u0632\u0631'],'family','patterned'],
  ['fp_glass_type',['\u0641\u064a\u0645\u064a\u0647'],'family','tinted'],
  ['edge',['\u0645\u0631\u0628\u0639'],'edge','square'],
  ['edge',['\u0645\u0628\u0631\u0648\u0645'],'edge','pencil'],
  ['edge',['\u062d\u0641'],'edge','ground'],
  ['edge',['\u0634\u0637\u0641','\u0634\u0637\u0641 1\u0633\u0645','\u0634\u0637\u0641 2\u0633\u0645','\u0634\u0637\u0641 2.5','\u0634\u0637\u06411\u0633\u0645+\u0645\u0631\u0628\u0639'],'edge','bevel'],
  ['process',['\u0645\u062f\u0647\u0648\u0646 \u0633\u064a\u0631\u0627\u0645\u064a\u0643'],'process','ceramic_paint'],
  ['process',['\u0645\u062f\u0647\u0648\u0646 \u0628\u0627\u0631\u062f'],'process','cold_paint'],
  ['process',['\u0645\u063a\u0634\u0649 \u0631\u0645\u0644'],'process','sandblasted'],
  ['process',['\u0641\u064a\u0644\u0645'],'process','film'],
  ['process',['\u0641\u0631\u0648\u0633\u062a\u064a\u062f \u0633\u064a\u0631\u0627\u0645\u064a\u0643'],'process','frosted_ceramic'],
  ['paint_color',['\u0627\u0633\u0648\u062f'],'paint_color','black'],
  ['paint_color',['\u0627\u0628\u064a\u0636'],'paint_color','white'],
  ['paint_color',['\u0631\u0645\u0627\u062f\u064a'],'paint_color','grey'],
  ['paint_color',['\u062d\u0644\u064a\u0628\u064a'],'paint_color','milky'],
  ['tempered',['\u0633\u064a\u0643\u0648\u0631\u064a\u062a'],'tempered','tempered'],
  ['tempered',['\u0628\u062f\u0648\u0646 \u0633\u064a\u0643\u0648\u0631\u064a\u062a'],'tempered','not_tempered'],
  ['brand',['agc'],'brand','agc'],
  ['brand',['obeikan','obk','\u0639\u0628\u064a\u0643\u0627\u0646'],'brand','obeikan'],
  ['brand',['\u0633\u0627\u0646 \u062c\u0648\u0628\u0627\u0646','saint-gobain','saint gobain'],'brand','saint_gobain'],
  ['brand',['guardian'],'brand','guardian'],
  ['brand',['qingdao jinjing'],'brand','qingdao_jinjing'],
  ['brand',['xyg'],'brand','xyg'],
  ['brand',['jingrun'],'brand','jingrun'],
  ['brand',['qin'],'brand','qin'],
  ['brand',['jin'],'brand','jin'],
  ['origin',['china','\u0635\u064a\u0646\u064a'],'origin','china'],
  ['origin',['belgium','\u0628\u0644\u062c\u064a\u0643\u064a'],'origin','belgium'],
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

// \u2500\u2500 3. Verifier (read-only) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
const lookAlias = db.prepare('SELECT value_id FROM attribute_value_aliases WHERE legacy_field=? AND alias=?');
function resolve(field, val){
  if(val==null) return {st:'NULL'};
  const raw=String(val).trim(); if(raw==='') return {st:'EMPTY'};
  const s=raw.toLowerCase();
  if((field==='color'||field==='fp_glass_type'||field==='family') && (s.startsWith('antique')||raw.startsWith('\u0627\u0646\u062a\u064a\u0643')))
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
console.log('RESULT:', dataOrphans===0 ? 'PASS \u2014 every data value resolves to a canonical id' : 'FAIL \u2014 data orphans exist (tell Claude; nothing existing was modified)');
db.close();

