// scripts/migrate-manufacturers.js
//
// One-shot migration: promotes the free-text raw_sheets.company column into
// proper rows in the new `manufacturers` table, links raw_sheets via
// manufacturer_id FK, and merges the known typo "Majdi Yacoub" into "Majed Yacoub".
//
// Properties:
// - Idempotent: re-running does nothing on a second pass (skips rows that
//   already have manufacturer_id, INSERT OR IGNORE on names).
// - Non-destructive: company and origin TEXT columns are kept untouched.
// - Self-verifying: prints before/after counts; aborts loudly if anything
//   looks wrong instead of silently doing the wrong thing.
//
// Run from the server root:  node scripts/migrate-manufacturers.js

const db = require('../db');

// ── 1. Make sure the schema is in place ──────────────────────────────────
// (The purchasing route file creates the table on server load, but this
//  script may be run before the server has been restarted.)
db.prepare(`CREATE TABLE IF NOT EXISTS manufacturers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  country TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT (datetime('now')),
  created_by TEXT
)`).run();

try { db.prepare('ALTER TABLE raw_sheets ADD COLUMN manufacturer_id INTEGER REFERENCES manufacturers(id)').run(); }
catch (_) { /* already exists */ }

// ── 2. Pre-flight: see what we're working with ─────────────────────────
const totalSheets = db.prepare('SELECT COUNT(*) c FROM raw_sheets').get().c;
const linkedBefore = db.prepare('SELECT COUNT(*) c FROM raw_sheets WHERE manufacturer_id IS NOT NULL').get().c;
const sheetsWithBrand = db.prepare("SELECT COUNT(*) c FROM raw_sheets WHERE company IS NOT NULL AND TRIM(company) != ''").get().c;
const manufBefore = db.prepare('SELECT COUNT(*) c FROM manufacturers').get().c;

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('Manufacturers migration — pre-flight');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  raw_sheets total:                ', totalSheets);
console.log('  raw_sheets with company text:      ', sheetsWithBrand);
console.log('  raw_sheets already linked (FK):  ', linkedBefore);
console.log('  manufacturers rows existing:     ', manufBefore);
console.log('');

// ── 3. Find the unique company strings ────────────────────────────────────
// For each unique company (post-merge), find the most common origin so we
// can populate manufacturers.country with sensible defaults.
const rawBrands = db.prepare(`
  SELECT company, origin, COUNT(*) AS n
  FROM raw_sheets
  WHERE company IS NOT NULL AND TRIM(company) != ''
  GROUP BY company, origin
`).all();

// Apply the known typo merge: "Majdi Yacoub" → "Majed Yacoub"
const TYPO_MERGES = {
  'Majdi Yacoub': 'Majed Yacoub',
};
function canonName(name) {
  const trimmed = String(name).trim();
  return TYPO_MERGES[trimmed] || trimmed;
}

// Aggregate by canonical name; for each, pick the most common origin
const byCanon = new Map(); // canonName → { country: mostCommonOrigin, totalSheets }
for (const row of rawBrands) {
  const canon = canonName(row.company);
  if (!byCanon.has(canon)) byCanon.set(canon, { origins: {}, total: 0 });
  const entry = byCanon.get(canon);
  const origin = (row.origin || '').trim();
  entry.origins[origin] = (entry.origins[origin] || 0) + row.n;
  entry.total += row.n;
}

console.log('Discovered ' + byCanon.size + ' unique manufacturers (after typo merges):');
for (const [name, info] of byCanon) {
  // Pick the origin with the highest count
  const bestOrigin = Object.entries(info.origins).sort((a, b) => b[1] - a[1])[0];
  const country = bestOrigin && bestOrigin[0] ? bestOrigin[0] : '';
  console.log('  • ' + name.padEnd(20) + ' country=' + (country || '(none)').padEnd(12) + ' used by ' + info.total + ' sheet(s)');
  info.country = country;
}
console.log('');

// ── 4. Insert manufacturer rows (skip if name already exists) ───────────
const insStmt = db.prepare(`INSERT OR IGNORE INTO manufacturers (name, country, created_by) VALUES (?, ?, ?)`);
let insertedCount = 0;
for (const [name, info] of byCanon) {
  const r = insStmt.run(name, info.country, 'migration');
  if (r.changes > 0) insertedCount++;
}
console.log('Inserted ' + insertedCount + ' new manufacturer row(s) (existing names left untouched).');
console.log('');

// ── 5. Link raw_sheets to manufacturer rows ────────────────────────────
// Only update rows that don't already have a manufacturer_id (idempotent).
// Match on canonical name so "Majdi Yacoub" rows get the "Majed Yacoub" id.
const lookupStmt = db.prepare('SELECT id FROM manufacturers WHERE name = ?');
const updateStmt = db.prepare('UPDATE raw_sheets SET manufacturer_id = ? WHERE id = ? AND manufacturer_id IS NULL');

const sheetsToLink = db.prepare(`
  SELECT id, company, origin
  FROM raw_sheets
  WHERE manufacturer_id IS NULL
    AND company IS NOT NULL AND TRIM(company) != ''
`).all();

let linkedNow = 0;
let skippedNoMatch = 0;
const txn = db.transaction(() => {
  for (const sheet of sheetsToLink) {
    const canon = canonName(sheet.company);
    const m = lookupStmt.get(canon);
    if (!m) {
      skippedNoMatch++;
      continue;
    }
    const r = updateStmt.run(m.id, sheet.id);
    if (r.changes > 0) linkedNow++;
  }
});
txn();

console.log('Linked ' + linkedNow + ' raw_sheets to a manufacturer.');
if (skippedNoMatch > 0) console.log('Skipped ' + skippedNoMatch + " (couldn't match name — investigate).");
console.log('');

// ── 6. Post-flight verification ────────────────────────────────────────
const linkedAfter = db.prepare('SELECT COUNT(*) c FROM raw_sheets WHERE manufacturer_id IS NOT NULL').get().c;
const noBrandNoMfg = db.prepare(`
  SELECT COUNT(*) c FROM raw_sheets
  WHERE manufacturer_id IS NULL
    AND (company IS NULL OR TRIM(company) = '')
`).get().c;
const haveBrandButNoMfg = db.prepare(`
  SELECT COUNT(*) c FROM raw_sheets
  WHERE manufacturer_id IS NULL
    AND company IS NOT NULL AND TRIM(company) != ''
`).get().c;
const manufAfter = db.prepare('SELECT COUNT(*) c FROM manufacturers').get().c;

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('Post-flight summary');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  raw_sheets linked to manufacturer:  ', linkedAfter, '/', totalSheets);
console.log('  raw_sheets with no company & no FK:   ', noBrandNoMfg, '(expected for items without company)');
console.log('  raw_sheets WITH company but no FK:    ', haveBrandButNoMfg, haveBrandButNoMfg > 0 ? '⚠️ INVESTIGATE' : '✓');
console.log('  manufacturers total:                ', manufAfter);
console.log('');

// Sanity check on the merge
const majedId = lookupStmt.get('Majed Yacoub');
const majdiId = lookupStmt.get('Majdi Yacoub');
if (majedId) {
  const merged = db.prepare("SELECT COUNT(*) c FROM raw_sheets WHERE manufacturer_id = ?").get(majedId.id).c;
  console.log('Majed Yacoub now has', merged, 'sheet(s) linked');
  if (majdiId) {
    console.log('⚠️ "Majdi Yacoub" exists as a separate manufacturer row — merge incomplete.');
  } else {
    console.log('✓ "Majdi Yacoub" is not a separate row (typo successfully merged).');
  }
}

if (haveBrandButNoMfg > 0) {
  console.log('');
  console.log('⚠️ WARNING:', haveBrandButNoMfg, 'raw_sheet rows have a company but no manufacturer_id.');
  console.log('   This usually means those brands failed the INSERT step (unique conflict?).');
  console.log('   Inspect with:');
  console.log('     SELECT id, code, company FROM raw_sheets WHERE manufacturer_id IS NULL AND TRIM(company) != "";');
  process.exit(1);
}

console.log('');
console.log('✅ Migration complete. company and origin columns left untouched as a backup.');
