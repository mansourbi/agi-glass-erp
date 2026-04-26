const db = require('../db');
const u  = require('os').userInfo().username;
const list = db.prepare("SELECT id FROM remnants WHERE status<>'discarded'").all();
const tx = db.transaction(() => {
  const upd = db.prepare("UPDATE remnants SET status='discarded' WHERE id=?");
  const log = db.prepare("INSERT INTO remnant_log (remnant_id,action,note,worker_name) VALUES (?,?,?,?)");
  for (const r of list) {
    upd.run(r.id);
    log.run(r.id, 'discarded', 'Bulk reset before re-entry from physical count', u);
  }
});
tx();
console.log('Discarded', list.length, 'remnants. Each got a remnant_log entry.');
