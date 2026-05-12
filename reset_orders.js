const db = require('./db');
const nums = ['REF-90', 'REF-91'];
for (const num of nums) {
  const o = db.prepare("SELECT id, status FROM orders WHERE num=?").get(num);
  if (!o) { console.log(num, 'not found'); continue; }
  db.prepare("UPDATE orders SET status='pending', completed_at=NULL, completed_by=NULL WHERE id=?").run(o.id);
  console.log(num, 'reset to pending');
}
