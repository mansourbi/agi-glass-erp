// scripts/fix-fadl-dimensions.js
//
// One-shot fix for raw_sheets that contain "فضل" (Fadl / leftover) in their
// code or description and have placeholder dimensions of 9999 × 9999.
// These were entered as stubs and need to be normalized to 4000 × 2500.
//
// Properties:
// - Idempotent: re-running does nothing on a second pass (no rows match
//   the filter once they've been fixed).
// - Safe: shows the rows it WILL change before changing them, then changes
//   them in a single transaction. If something looks wrong, abort with Ctrl+C.

const db = require('../db');

const LIKE_PATTERN = '%فضل%';
const PLACEHOLDER_W = 9999;
const PLACEHOLDER_H = 9999;
const NEW_W = 4000;
const NEW_H = 2500;

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('Fadl (فضل) dimensions fix');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

// Find candidates — any raw_sheets row with "فضل" anywhere in code or notes,
// at the placeholder size 9999 × 9999.
const rows = db.prepare(`
  SELECT id, code, glass_type, color, thickness, w, h, notes
  FROM raw_sheets
  WHERE (code LIKE ? OR notes LIKE ?)
    AND w = ? AND h = ?
  ORDER BY code
`).all(LIKE_PATTERN, LIKE_PATTERN, PLACEHOLDER_W, PLACEHOLDER_H);

if (rows.length === 0) {
  console.log('');
  console.log('No matching rows found. Nothing to do.');
  console.log('(Either already fixed, or no "فضل" sheets at 9999×9999 exist.)');
  process.exit(0);
}

console.log('');
console.log('Found ' + rows.length + ' row(s) to fix:');
console.log('');
console.log('  ID  | CODE                       | TYPE   | COLOR     | THICK | CURRENT W×H   → NEW W×H');
console.log('  ----+----------------------------+--------+-----------+-------+----------------------------');
rows.forEach(r => {
  console.log(
    '  ' + String(r.id).padStart(3) + ' | ' +
    (r.code || '').padEnd(26) + ' | ' +
    (r.glass_type || '').padEnd(6) + ' | ' +
    (r.color || '').padEnd(9) + ' | ' +
    String(r.thickness || '').padEnd(5) + ' | ' +
    (String(r.w) + 'x' + String(r.h)).padEnd(13) + ' → ' +
    NEW_W + 'x' + NEW_H
  );
});

console.log('');
console.log('Applying update...');

const updateStmt = db.prepare(`
  UPDATE raw_sheets
  SET w = ?, h = ?, updated_at = datetime('now')
  WHERE id = ?
`);

const txn = db.transaction((items) => {
  for (const r of items) updateStmt.run(NEW_W, NEW_H, r.id);
});
txn(rows);

console.log('✓ Updated ' + rows.length + ' row(s) to ' + NEW_W + ' × ' + NEW_H + '.');
console.log('');

// Post-flight verification
const remaining = db.prepare(`
  SELECT COUNT(*) c
  FROM raw_sheets
  WHERE (code LIKE ? OR notes LIKE ?)
    AND w = ? AND h = ?
`).get(LIKE_PATTERN, LIKE_PATTERN, PLACEHOLDER_W, PLACEHOLDER_H).c;

console.log('Remaining "فضل" rows at 9999×9999: ' + remaining + (remaining === 0 ? ' ✓' : ' ⚠️'));
console.log('');
console.log('✅ Done. Hard-refresh the browser (Ctrl+Shift+F5) to see the changes.');
