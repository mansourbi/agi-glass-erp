// scripts/merge-manufacturers.js
//
// One-shot merge: collapses near-duplicate manufacturer rows that came out of
// the initial migration as separate entries because the source raw_sheets.company
// text used different romanizations.
//
// Specific merges (loser → keeper):
//   JIN              → Jingrun
//   QIN              → Qingdao Jinjing
//
// Procedure for each pair:
//   1. Verify both rows exist
//   2. Re-point all raw_sheets with manufacturer_id = LOSER to the KEEPER's id
//   3. Delete the LOSER row
//
// Idempotent: if the loser is already gone, the script reports it and skips.
// Non-destructive to raw_sheets: only the manufacturer_id FK changes; the
// legacy `company` text on raw_sheets is left as-is (still says "JIN" /
// "QIN" on those rows, which is the audit trail of what was originally typed).

const db = require('../db');

const MERGES = [
  { loser: 'JIN', keeper: 'Jingrun' },
  { loser: 'QIN', keeper: 'Qingdao Jinjing' },
];

const lookup = db.prepare('SELECT id, name FROM manufacturers WHERE name = ?');
const repointStmt = db.prepare('UPDATE raw_sheets SET manufacturer_id = ? WHERE manufacturer_id = ?');
const deleteStmt = db.prepare('DELETE FROM manufacturers WHERE id = ?');

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('Manufacturer merge');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

const txn = db.transaction(() => {
  for (const { loser, keeper } of MERGES) {
    const loserRow = lookup.get(loser);
    const keeperRow = lookup.get(keeper);

    if (!keeperRow) {
      console.log(`  SKIP: keeper "${keeper}" not found — manual fix needed.`);
      continue;
    }
    if (!loserRow) {
      console.log(`  SKIP: loser "${loser}" already gone (already merged?).`);
      continue;
    }
    if (loserRow.id === keeperRow.id) {
      console.log(`  SKIP: "${loser}" and "${keeper}" already point to same row.`);
      continue;
    }

    const result = repointStmt.run(keeperRow.id, loserRow.id);
    deleteStmt.run(loserRow.id);
    console.log(`  ✓ Merged "${loser}" → "${keeper}": ${result.changes} sheet(s) repointed, loser row deleted.`);
  }
});
txn();

console.log('');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('Final manufacturer list');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
const rows = db.prepare(`
  SELECT m.id, m.name, m.country,
         (SELECT COUNT(*) FROM raw_sheets rs WHERE rs.manufacturer_id = m.id) AS sheets
  FROM manufacturers m
  ORDER BY m.name
`).all();
rows.forEach(m => {
  console.log('  ' + String(m.id).padStart(2) + ' | ' + m.name.padEnd(22) + ' | ' + (m.country || '').padEnd(12) + ' | ' + m.sheets + ' sheet(s)');
});

const totalLinked = db.prepare('SELECT COUNT(*) c FROM raw_sheets WHERE manufacturer_id IS NOT NULL').get().c;
const totalSheets = db.prepare('SELECT COUNT(*) c FROM raw_sheets').get().c;
console.log('');
console.log(`raw_sheets linked: ${totalLinked} / ${totalSheets}`);
console.log('');
console.log('✅ Merge complete. raw_sheets.company text columns left untouched (audit trail).');
