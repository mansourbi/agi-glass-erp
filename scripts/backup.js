// scripts/backup.js — run nightly via Task Scheduler
// Copies the SQLite database to a timestamped backup file
const fs   = require('fs');
const path = require('path');

const DB_PATH     = process.env.DB_PATH || path.join(__dirname, '../agi-glass.db');
const BACKUP_DIR  = process.env.BACKUP_DIR || path.join(__dirname, '../backups');
const KEEP_DAYS   = parseInt(process.env.KEEP_DAYS) || 30;

// Create backups folder if needed
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

// Timestamped filename
const ts       = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
const destFile = path.join(BACKUP_DIR, `agi-glass-${ts}.db`);

try {
  fs.copyFileSync(DB_PATH, destFile);
  console.log(`[Backup] Saved: ${destFile}`);

  // Delete backups older than KEEP_DAYS
  const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
  const files  = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.db'));
  let deleted  = 0;
  files.forEach(f => {
    const fp   = path.join(BACKUP_DIR, f);
    const stat = fs.statSync(fp);
    if (stat.mtimeMs < cutoff) { fs.unlinkSync(fp); deleted++; }
  });
  if (deleted) console.log(`[Backup] Deleted ${deleted} old backup(s)`);
  console.log(`[Backup] Total backups kept: ${files.length - deleted}`);
} catch(e) {
  console.error('[Backup] ERROR:', e.message);
  process.exit(1);
}
