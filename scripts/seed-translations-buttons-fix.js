// scripts/seed-translations-buttons-fix.js
// Plug the gaps found by auditing buttons without data-i18n. The fallback
// auto-translation in applyLang looks these up by exact-text match (after
// stripping leading symbols/emoji).

const db = require('../db');

db.prepare(`CREATE TABLE IF NOT EXISTS translations (key TEXT PRIMARY KEY, en TEXT, ar TEXT, section TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`).run();

const seed = [
  ['New Customer', 'عميل جديد'],
  ['Add Piece', 'إضافة قطعة'],
  ['Optimize Cuts', 'تحسين القص'],
  ['Go to Cutting ❯', 'اذهب للقص ❯'],
  ['Excel (scans)', 'إكسل (المسح)'],
  ['Excel (full)', 'إكسل (كامل)'],
  ['Add Remnant', 'إضافة بقية'],
  ['New Delivery', 'تسليم جديد'],
  ['Add Slot', 'إضافة فتحة'],
  ['Add Receiver', 'إضافة مستلم'],
  ['Stock & Purchases', 'المخزون والمشتريات'],
  ['Add Sheet', 'إضافة لوح'],
  ['Record Purchase', 'تسجيل شراء'],
  ['Add Record', 'إضافة سجل'],
  ['Add Type', 'إضافة نوع'],
  ['Add Adjustment', 'إضافة تعديل'],
  ['Accrue This Month', 'استحقاق هذا الشهر'],
  ['Add Worker', 'إضافة عامل'],
  ['Add Family', 'إضافة عائلة'],
  ['Add Product', 'إضافة منتج'],
  ['Add Reason', 'إضافة سبب'],
  ['Export Full Backup', 'تصدير نسخة احتياطية كاملة'],
  ['Clear All Data', 'مسح كل البيانات'],
  ['HR / Payroll', 'الموارد البشرية / الرواتب'],
  ['Sheets & Slots', 'الألواح والفتحات'],
  ['Assignments & Transfers', 'التعيينات والتحويلات'],
  ['Opt Deductions', 'خصومات التحسين'],
];

const stmt = db.prepare(`INSERT INTO translations (key, en, ar, section) VALUES (?, ?, ?, 'buttons') ON CONFLICT(key) DO UPDATE SET ar = excluded.ar, en = excluded.en, updated_at = CURRENT_TIMESTAMP`);
const txn = db.transaction((rows) => { for (const [k, a] of rows) stmt.run(k, k, a); });
txn(seed);
console.log('Seeded ' + seed.length + ' button-label translations.');
