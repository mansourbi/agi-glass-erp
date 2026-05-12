const db = require('./db');
const bad = db.prepare("SELECT si.id, si.slot_id, si.date, si.sheet_id, si.qty, afs.name AS slot_name FROM slot_inventory si JOIN a_frame_slots afs ON afs.id=si.slot_id WHERE si.type='deduct' AND si.ref_type='manual' AND (si.notes IS NULL OR si.notes='')").all();
console.log('Found', bad.length, 'empty-notes deduct rows');
bad.forEach(row => {
  const match = db.prepare("SELECT afs.name AS dest FROM slot_inventory si JOIN a_frame_slots afs ON afs.id=si.slot_id WHERE si.type='assign' AND si.ref_type='manual' AND si.date=? AND si.qty=? AND si.sheet_id=? AND si.notes LIKE 'Transfer from slot%' LIMIT 1").get(row.date, Math.abs(row.qty), row.sheet_id);
  if(match){
    db.prepare("UPDATE slot_inventory SET notes=? WHERE id=?").run('Transfer to slot '+match.dest, row.id);
    console.log('Fixed:', row.slot_name, '->', match.dest);
  }
});
console.log('Done');
