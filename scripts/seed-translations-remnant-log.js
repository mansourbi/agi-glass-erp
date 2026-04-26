// scripts/seed-translations-remnant-log.js
const db = require('../db');

db.prepare(`CREATE TABLE IF NOT EXISTS translations (key TEXT PRIMARY KEY, en TEXT, ar TEXT, section TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`).run();

const seed = [
  ['Activity Log', 'سجل النشاط'],
  ['Remnant Activity Log', 'سجل نشاط البقايا'],
  ['History', 'السجل'],
  ['View history', 'عرض السجل'],
  ['No history yet', 'لا يوجد سجل بعد'],
  ['No activity matching the filters.', 'لا يوجد نشاط مطابق للمرشحات.'],
  ['When', 'متى'],
  ['Action', 'الإجراء'],
  ['Remnant', 'البقية'],
  ['All Actions', 'كل الإجراءات'],
  ['All Workers', 'كل العمال'],
  ['Created', 'تم الإنشاء'],
  ['Used', 'مستخدم'],
  ['Discarded', 'مهمل'],
  ['Note', 'ملاحظة'],
  ['Search UID, order, piece, notes...', 'بحث بالمعرّف، الطلب، القطعة، الملاحظات...'],
];

const stmt = db.prepare(`INSERT INTO translations (key, en, ar, section) VALUES (?, ?, ?, 'remnant_log') ON CONFLICT(key) DO UPDATE SET ar = excluded.ar, updated_at = CURRENT_TIMESTAMP`);
const txn = db.transaction((rows) => { for (const [k, a] of rows) stmt.run(k, k, a); });
txn(seed);
console.log('Seeded ' + seed.length + ' remnant-log translations.');
