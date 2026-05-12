const db = require('./db');
const sheet = db.prepare("SELECT id FROM raw_sheets WHERE code='10FLO-MJYCHN-CLR-01'").get();
console.log('Sheet id:', sheet.id);

// Check slot inventory net for this sheet
const net = db.prepare("SELECT COALESCE(SUM(qty),0) AS net FROM slot_inventory WHERE sheet_id=?").get(sheet.id);
console.log('Slot net:', net.net);

// Stock balance
const stock = db.prepare("SELECT current_qty_in_stock_units FROM raw_sheets WHERE id=?").get(sheet.id);
console.log('Stock balance:', stock.current_qty_in_stock_units);
console.log('Difference:', stock.current_qty_in_stock_units - net.net);

// Show all slot_inventory rows
const rows = db.prepare("SELECT si.*, afs.name AS slot_name FROM slot_inventory si JOIN a_frame_slots afs ON afs.id=si.slot_id WHERE si.sheet_id=? ORDER BY si.date, si.id").all(sheet.id);
rows.forEach(r => console.log(r.date, r.slot_name, r.qty, r.type, r.notes?.slice(0,30)));
