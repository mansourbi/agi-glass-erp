// Block G-1a migration: snapshot + add per-customer-copy columns to price_profiles.
// Idempotent. Run from C:\agi-server so better-sqlite3 resolves.
const Database=require('better-sqlite3'), fs=require('fs'), path=require('path');
const DB='C:\\agi-server\\agi-glass.db';
const db=new Database(DB);
const dir='C:\\agi-server\\_checkpoints'; fs.mkdirSync(dir,{recursive:true});
const ts=new Date().toISOString().replace(/[-:T]/g,'').slice(0,15);
const snap=path.join(dir,'agi-glass_preG1_'+ts+'.db');
try{ db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); }catch(e){}
db.prepare("VACUUM INTO ?").run(snap);
console.log('snapshot: '+snap);
const cols=db.prepare("PRAGMA table_info(price_profiles)").all().map(c=>c.name);
const added=[];
if(!cols.includes('customer_id')){ db.exec("ALTER TABLE price_profiles ADD COLUMN customer_id INTEGER"); added.push('customer_id'); }
if(!cols.includes('source_profile_id')){ db.exec("ALTER TABLE price_profiles ADD COLUMN source_profile_id INTEGER"); added.push('source_profile_id'); }
console.log('added columns: '+(added.length?added.join(', '):'(none - already present)'));
const tot=db.prepare("SELECT COUNT(*) c FROM price_profiles").get().c;
const glob=db.prepare("SELECT COUNT(*) c FROM price_profiles WHERE customer_id IS NULL").get().c;
console.log('price_profiles: total='+tot+', global(customer_id NULL)='+glob+', customer-owned='+(tot-glob));
db.close();
console.log('G-1a migration done.');

