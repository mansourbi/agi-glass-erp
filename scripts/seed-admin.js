// scripts/seed-admin.js — run once to create the first admin account
// Usage: node scripts/seed-admin.js
const bcrypt = require('bcryptjs');
const db     = require('../db');

const ADMIN = {
  name:     process.env.ADMIN_NAME     || 'Admin',
  email:    process.env.ADMIN_EMAIL    || 'admin@agiglass.com',
  password: process.env.ADMIN_PASSWORD || 'Admin@1234'
};

const hash = bcrypt.hashSync(ADMIN.password, 10);
try {
  const r = db.prepare(`
    INSERT INTO workers (name,email,pass_hash,role,processes)
    VALUES (?,?,?,'admin','[]')
  `).run(ADMIN.name, ADMIN.email.toLowerCase(), hash);
  console.log('\nAdmin created successfully:');
  console.log('  Email:   ', ADMIN.email);
  console.log('  Password:', ADMIN.password);
  console.log('  ID:      ', r.lastInsertRowid);
  console.log('\nChange your password after first login!\n');
} catch(e) {
  if (e.message.includes('UNIQUE')) {
    console.log('Admin already exists for:', ADMIN.email);
  } else {
    console.error('Error:', e.message);
  }
}
process.exit(0);
