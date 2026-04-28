// scripts/seed-translations-manufacturers.js
const db = require('../db');

db.prepare(`CREATE TABLE IF NOT EXISTS translations (key TEXT PRIMARY KEY, en TEXT, ar TEXT, section TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`).run();

const seed = [
  // Manufacturers tab and modal
  ['Manufacturer', 'الصانع'],
  ['Manufacturers', 'الصُنّاع'],
  ['Add Manufacturer', 'إضافة صانع'],
  ['Edit Manufacturer', 'تعديل الصانع'],
  ['Search manufacturers...', 'بحث الصُنّاع...'],
  ['No manufacturers yet. Click + Add Manufacturer.', 'لا يوجد صُنّاع. اضغط + إضافة صانع.'],
  ['All Manufacturers', 'كل الصُنّاع'],
  ['Raw Sheets', 'الألواح الخام'],
  ['— Pick manufacturer or add new —', '— اختر صانع أو أضف جديد —'],
  // Vendor labels (replacing Supplier in UI)
  ['Vendor', 'البائع'],
  ['Vendors', 'البائعون'],
  ['Add Vendor', 'إضافة بائع'],
  ['Edit Vendor', 'تعديل البائع'],
  ['Search vendors...', 'بحث البائعين...'],
  ['— Pick vendor or add new —', '— اختر بائع أو أضف جديد —'],
];

const stmt = db.prepare(`INSERT INTO translations (key, en, ar, section) VALUES (?, ?, ?, 'manufacturers') ON CONFLICT(key) DO UPDATE SET ar = excluded.ar, en = excluded.en, updated_at = CURRENT_TIMESTAMP`);
const txn = db.transaction((rows) => { for (const [k, a] of rows) stmt.run(k, k, a); });
txn(seed);
console.log('Seeded ' + seed.length + ' manufacturer/vendor translations.');
