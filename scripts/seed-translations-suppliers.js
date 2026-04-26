// scripts/seed-translations-suppliers.js
const db = require('../db');

db.prepare(`CREATE TABLE IF NOT EXISTS translations (key TEXT PRIMARY KEY, en TEXT, ar TEXT, section TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`).run();

const seed = [
  ['Suppliers', 'الموردون'],
  ['Add Supplier', 'إضافة مورد'],
  ['Edit Supplier', 'تعديل المورد'],
  ['Search suppliers...', 'بحث الموردين...'],
  ['Default Currency', 'العملة الافتراضية'],
  ['Payment Terms', 'شروط الدفع'],
  ['Lead Time (days)', 'مهلة التوريد (أيام)'],
  ['POs', 'أوامر شراء'],
  ['Total Spend (JOD)', 'إجمالي الإنفاق (د.أ)'],
  ['Spend (JOD)', 'الإنفاق (د.أ)'],
  ['Active only', 'النشطون فقط'],
  ['No suppliers yet. Click + Add Supplier.', 'لا يوجد موردون. اضغط + إضافة مورد.'],
  ['— Pick supplier or add new —', '— اختر مورد أو أضف جديد —'],
  ['Auto-filled from supplier', 'يُعبأ تلقائياً من المورد'],
];

const stmt = db.prepare(`INSERT INTO translations (key, en, ar, section) VALUES (?, ?, ?, 'suppliers') ON CONFLICT(key) DO UPDATE SET ar = excluded.ar, updated_at = CURRENT_TIMESTAMP`);
const txn = db.transaction((rows) => { for (const [k, a] of rows) stmt.run(k, k, a); });
txn(seed);
console.log('Seeded ' + seed.length + ' supplier translations.');
