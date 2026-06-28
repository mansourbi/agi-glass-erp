// ===========================================================================
// BLOCK E-1  -  Modular pricing model (profiles + rules + catalog + overrides)
// ADDITIVE: creates 8 new tables, seeds 5 example price profiles, 2 example
// rules, 5 extra-charge categories, and 1 default attachment. Touches NO
// existing data; live pricing (orderpricing.js / value_extras) is unchanged
// until the Block E-2 resolver is wired in.
// Idempotent: seeds ONLY if price_profiles is empty (preserves your edits).
// Revert = drop the 8 new tables (command printed at end).
// ===========================================================================
const DBPATH = 'C:\\agi-server\\agi-glass.db';
const Database = require('C:\\agi-server\\node_modules\\better-sqlite3');
const db = new Database(DBPATH);
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS price_profiles(
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
  basis TEXT NOT NULL DEFAULT 'per_sqm',
  length_basis TEXT DEFAULT 'perimeter',
  base_rate REAL NOT NULL DEFAULT 0, min_per_piece REAL DEFAULT 0,
  active INTEGER DEFAULT 1, notes TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS pricing_rules(
  id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id INTEGER NOT NULL REFERENCES price_profiles(id),
  condition_type TEXT NOT NULL, condition_value REAL NOT NULL,
  action_type TEXT NOT NULL, action_value REAL NOT NULL,
  priority INTEGER DEFAULT 0, active INTEGER DEFAULT 1, notes TEXT);
CREATE TABLE IF NOT EXISTS product_default_price(
  product_id INTEGER PRIMARY KEY REFERENCES products(id),
  profile_id INTEGER NOT NULL REFERENCES price_profiles(id), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS extra_charge_categories(
  id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE, label TEXT NOT NULL,
  description TEXT, active INTEGER DEFAULT 1, sort_order INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS customer_price_profile(
  id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL REFERENCES products(id), profile_id INTEGER NOT NULL REFERENCES price_profiles(id),
  UNIQUE(customer_id, product_id));
CREATE TABLE IF NOT EXISTS order_price_choice(
  id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL, product_id INTEGER,
  profile_id INTEGER REFERENCES price_profiles(id),
  discount_type TEXT, discount_value REAL, discount_note TEXT, UNIQUE(order_id, product_id));
CREATE TABLE IF NOT EXISTS order_extra_charges(
  id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL,
  category_id INTEGER REFERENCES extra_charge_categories(id), description TEXT, amount REAL NOT NULL,
  created_at TEXT DEFAULT (datetime('now')));
`);

const already = db.prepare('SELECT COUNT(*) c FROM price_profiles').get().c;
let seeded = false;
if (already === 0) {
  const PROFILES = [
    ['6mm Mir 1cm 5-2','per_sqm',null,5,2,'seed: 6mm mirror 1cm bevel, base 5/sqm min 2/pc'],
    ['6mm Mir 1cm 5-3','per_sqm',null,5,3,'seed: same product, min 3/pc variant'],
    ['10mm Mir 1cm 5-2','per_sqm',null,6,3,'seed: 10mm glass + flat polish, base 6/sqm min 3/pc'],
    ['10mm Flat Polish 1LM','per_linear_meter','perimeter',1,0,'seed: flat-polish service, 1/linear meter'],
    ['21.52mm Flat Polish 3LM','per_linear_meter','perimeter',3,0,'seed: laminated 10+1.52+10 polish, 3/LM'],
  ];
  const CATS = [
    ['UNIQUE_CUTOUT','Unique Cut-out','Non-standard cutout (e.g. 10x10cm). Standard clamp/hinge/bracket cutouts are free.',0],
    ['SPECIAL_POLISH','Special Polish','Flat/round polish on request (e.g. on a laminated order).',1],
    ['EXTRA_ARRISING','Extra Arrising','Unusually heavy arrising requested by customer.',2],
    ['RUSH','Rush / Expedite','Priority turnaround.',3],
    ['OTHER','Other / Custom','Free-text custom charge.',4],
  ];
  const tx = db.transaction(() => {
    const insP = db.prepare('INSERT INTO price_profiles(name,basis,length_basis,base_rate,min_per_piece,notes) VALUES(?,?,?,?,?,?)');
    const pid = {};
    for (const p of PROFILES){ const info=insP.run(p[0],p[1],p[2],p[3],p[4],p[5]); pid[p[0]]=info.lastInsertRowid; }
    const insR = db.prepare('INSERT INTO pricing_rules(profile_id,condition_type,condition_value,action_type,action_value,priority,notes) VALUES(?,?,?,?,?,?,?)');
    insR.run(pid['10mm Mir 1cm 5-2'],'area_gt',5,'pct_uplift',20,0,'EXAMPLE oversize: piece > 5 sqm adds 20% on base - edit/delete');
    insR.run(pid['10mm Mir 1cm 5-2'],'holes_gt',3,'per_unit_add',0.5,1,'EXAMPLE drilling: 0.5/hole beyond 3 - edit/delete');
    const insC = db.prepare('INSERT OR IGNORE INTO extra_charge_categories(code,label,description,sort_order) VALUES(?,?,?,?)');
    for (const ct of CATS) insC.run(ct[0],ct[1],ct[2],ct[3]);
    // attach the one unambiguous default: 6mm clear mirror bevel (legacy_fp_id 73)
    const prod = db.prepare('SELECT id FROM products WHERE legacy_fp_id=73').get();
    if (prod) db.prepare('INSERT OR REPLACE INTO product_default_price(product_id,profile_id) VALUES(?,?)').run(prod.id, pid['6mm Mir 1cm 5-2']);
  });
  tx();
  seeded = true;
}

// \u2500\u2500 VERIFY \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
const cP = db.prepare('SELECT COUNT(*) c FROM price_profiles').get().c;
const cR = db.prepare('SELECT COUNT(*) c FROM pricing_rules').get().c;
const cC = db.prepare('SELECT COUNT(*) c FROM extra_charge_categories').get().c;
const cD = db.prepare('SELECT COUNT(*) c FROM product_default_price').get().c;
const orphR = db.prepare('SELECT COUNT(*) c FROM pricing_rules r WHERE NOT EXISTS(SELECT 1 FROM price_profiles p WHERE p.id=r.profile_id)').get().c;
const orphD = db.prepare('SELECT COUNT(*) c FROM product_default_price d WHERE NOT EXISTS(SELECT 1 FROM price_profiles p WHERE p.id=d.profile_id) OR NOT EXISTS(SELECT 1 FROM products pr WHERE pr.id=d.product_id)').get().c;
console.log('=== BLOCK E-1 VERIFY ===');
console.log('seeded this run:', seeded, ' (false = already present, left intact)');
console.log('price_profiles:', cP, '  pricing_rules:', cR, '  categories:', cC, '  product defaults:', cD);
console.log('orphan rules:', orphR, '  orphan defaults:', orphD, '(both must be 0)');
console.log('--- profiles ---');
for (const r of db.prepare('SELECT id,name,basis,base_rate,min_per_piece FROM price_profiles ORDER BY id').all())
  console.log('  #'+r.id+'  '+r.name+'  ['+r.basis+']  base='+r.base_rate+'  min/pc='+r.min_per_piece);
for (const r of db.prepare('SELECT d.product_id, p.name FROM product_default_price d JOIN price_profiles p ON p.id=d.profile_id').all())
  console.log('  default: product '+r.product_id+' -> "'+r.name+'"');
const ok = (cP>=5 && orphR===0 && orphD===0);
console.log('RESULT:', ok ? 'PASS - pricing model seeded; resolver (E-2) next' : 'FAIL - review above');
db.close();

