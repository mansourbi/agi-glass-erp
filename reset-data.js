// reset-data.js — clears transactional data, keeps config/setup
// Run with: node reset-data.js
const db = require('./db.js');

console.log('Starting data reset...\n');

const tables = [
  'scan_log',
  'label_items',
  'order_items',
  'orders',
  'opt_files',
  'remnant_log',
  'remnants',
];

db.prepare('BEGIN').run();
try {
  tables.forEach(table => {
    try {
      const count = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
      db.prepare(`DELETE FROM ${table}`).run();
      db.prepare(`DELETE FROM sqlite_sequence WHERE name='${table}'`).run();
      console.log(`✓ Cleared ${table} (${count} rows)`);
    } catch(e) {
      console.log(`  skipped ${table}: ${e.message}`);
    }
  });
  db.prepare('COMMIT').run();
  console.log('\n✅ Reset complete. Setup data preserved.');
} catch(e) {
  db.prepare('ROLLBACK').run();
  console.error('\n❌ Error — rolled back:', e.message);
}
