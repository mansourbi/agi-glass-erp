const db = require('./db');
// Fix existing transfer deduct rows that lost their "Transfer to slot" notes
// They were saved with opt_name fallback, so notes = 'Opt #undefined' or 'Opt #null'
const bad = db.prepare("SELECT si.id, si.slot_id, si.date, afs.name AS slot_name FROM slot_inventory si JOIN a_frame_slots afs ON afs.id=si.slot_id WHERE si.type='deduct' AND si.ref_type='manual' AND (si.notes IS NULL OR si.notes='' OR si.notes LIKE 'Opt #%')").all();
console.log('Found', bad.length, 'transfer deduct rows to check');
// For each, find matching assign row same date/sheet/qty to get destination
bad.forEach(row => {
  const match = db.prepare("SELECT afs.name AS dest FROM slot_inventory si JOIN a_frame_slots afs ON afs.id=si.slot_id WHERE si.type='assign' AND si.ref_type='manual' AND si.date=? AND si.qty=(SELECT ABS(qty) FROM slot_inventory WHERE id=?) AND si.sheet_id=(SELECT sheet_id FROM slot_inventory WHERE id=?) AND si.notes LIKE 'Transfer from slot%' LIMIT 1").get(row.date, row.id, row.id);
  if(match){
    db.prepare("UPDATE slot_inventory SET notes=? WHERE id=?").run('Transfer to slot '+match.dest, row.id);
    console.log('Fixed:', row.slot_name, '->', match.dest);
  }
});
console.log('Done');
