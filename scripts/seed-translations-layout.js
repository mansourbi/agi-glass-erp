// scripts/seed-translations-layout.js
const db = require('../db');

db.prepare(`CREATE TABLE IF NOT EXISTS translations (key TEXT PRIMARY KEY, en TEXT, ar TEXT, section TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`).run();

const seed = [
  ['Layout', 'المخطط'],
  ['Factory Layout', 'مخطط المصنع'],
  ['Plan your factory floor — spaces, machines, and storage in real-world meters', 'خطط لأرضية المصنع - مساحات، آلات، تخزين بالأمتار الحقيقية'],
  ['Space', 'مساحة'],
  ['Rectangle', 'مستطيل'],
  ['Square', 'مربع'],
  ['Circle', 'دائرة'],
  ['Text', 'نص'],
  ['Items', 'العناصر'],
  ['Properties', 'الخصائص'],
  ['Fit', 'ملاءمة'],
];

const stmt = db.prepare(`INSERT INTO translations (key, en, ar, section) VALUES (?, ?, ?, 'layout') ON CONFLICT(key) DO UPDATE SET ar = excluded.ar, updated_at = CURRENT_TIMESTAMP`);
const txn = db.transaction((rows) => { for (const [k, a] of rows) stmt.run(k, k, a); });
txn(seed);
console.log('Seeded ' + seed.length + ' layout translations.');
