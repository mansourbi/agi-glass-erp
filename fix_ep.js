const db = require('./db');
const deliveries = db.prepare("SELECT id,serial FROM deliveries WHERE status='finalised'").all();
let updated = 0;
for (const d of deliveries) {
  const fi = db.prepare('SELECT order_id FROM delivery_items WHERE delivery_id=? AND order_id IS NOT NULL LIMIT 1').get(d.id);
  if (!fi) continue;
  const o = db.prepare('SELECT external_process_id FROM orders WHERE id=?').get(fi.order_id);
  if (!o || !o.external_process_id) continue;
  const ep = db.prepare('SELECT name FROM external_processes WHERE id=?').get(o.external_process_id);
  if (!ep) continue;
  db.prepare('UPDATE deliveries SET external_process_id=?,external_process_name=? WHERE id=?').run(o.external_process_id, ep.name, d.id);
  updated++;
  console.log('Updated', d.serial, '->', ep.name);
}
console.log('Done:', updated, 'updated');
