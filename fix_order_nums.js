const db = require('./db');

const fixes = [
  { order_id: 100, old_num: 'REF-67', new_num: 'REF-69' },
  { order_id: 102, old_num: 'REF-70', new_num: 'REF-76' },
  { order_id: 104, old_num: 'REF-72', new_num: 'REF-74' },
];

for (const f of fixes) {
  console.log('\nFixing ' + f.old_num + ' -> ' + f.new_num);

  // 1. Get labels to rename
  const labels = db.prepare("SELECT uid, code FROM label_items WHERE order_id=? AND uid LIKE ?")
    .all(f.order_id, f.old_num + '-%');
  for (const l of labels) {
    const newUid = l.uid.replace(f.old_num, f.new_num);
    const newCode = (l.code||'').replace(f.old_num, f.new_num);
    db.prepare("UPDATE label_items SET uid=?, code=?, order_num=? WHERE uid=?").run(newUid, newCode, f.new_num, l.uid);
    console.log('  label: ' + l.uid + ' -> ' + newUid);
  }

  // 2. Update delivery_items
  const ditems = db.prepare("SELECT id, piece_uid, piece_code FROM delivery_items WHERE order_id=? AND order_num=?")
    .all(f.order_id, f.old_num);
  for (const di of ditems) {
    const newUid = di.piece_uid.replace(f.old_num, f.new_num);
    const newCode = (di.piece_code||'').replace(f.old_num, f.new_num);
    db.prepare("UPDATE delivery_items SET order_num=?, piece_uid=?, piece_code=? WHERE id=?")
      .run(f.new_num, newUid, newCode, di.id);
    console.log('  delivery: ' + di.piece_uid + ' -> ' + newUid);
  }

  // 3. Update scan_log
  const slogs = db.prepare("SELECT id, piece_uid FROM scan_log WHERE order_id=? AND order_num=?")
    .all(f.order_id, f.old_num);
  for (const sl of slogs) {
    const newUid = sl.piece_uid.replace(f.old_num, f.new_num);
    db.prepare("UPDATE scan_log SET order_num=?, piece_uid=? WHERE id=?").run(f.new_num, newUid, sl.id);
  }
  console.log('  scan_log: ' + slogs.length + ' updated');
}

console.log('\nAll done.');
