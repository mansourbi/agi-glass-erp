const db = require('./db');
const deliveries = db.prepare("SELECT id, serial, external_process_id FROM deliveries WHERE external_process_id IS NOT NULL").all();
let updated = 0;
for (const d of deliveries) {
  const ep = db.prepare('SELECT name FROM external_processes WHERE id=?').get(d.external_process_id);
  if (!ep) continue;
  db.prepare('UPDATE deliveries SET external_process_name=? WHERE id=?').run(ep.name, d.id);
  console.log('Updated', d.serial, '->', ep.name);
  updated++;
}
console.log('\nDone:', updated, 'deliveries updated');
