// scripts/backup-db.js
// Creates a consistent snapshot of agi-glass.db using SQLite's backup API,
// even while the server is running. Also archives the uploads/ folder which
// holds order attachments (WhatsApp images etc) that aren't stored inline in
// the database.
//
// Outputs in C:\agi-backups\, named with today's date:
//   agi-glass-YYYY-MM-DD.db       — full DB snapshot
//   uploads-YYYY-MM-DD.zip        — zipped uploads/ folder (only if non-empty)
//
// After local backup succeeds, mirrors today's files into the Google Drive
// sync folder so they upload off-site automatically. The Drive folder is
// configured below (CLOUD_MIRROR_DIR). If that path doesn't exist (e.g.
// Drive Desktop not running), the cloud step is skipped with a warning.
//
// Keeps the most recent 30 days, auto-deleting older files of either kind
// from BOTH the local and cloud folders.
//
// Usage:
//   node scripts/backup-db.js
//
// Run nightly via Windows Task Scheduler. Logs to C:\agi-backups\backup.log

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const Database = require('better-sqlite3');

const SERVER_ROOT = path.join(__dirname, '..');
const SOURCE_DB   = path.join(SERVER_ROOT, 'agi-glass.db');
const UPLOADS_DIR = path.join(SERVER_ROOT, 'uploads');
const BACKUP_DIR  = 'C:\\agi-backups';
// Off-site mirror — points into the Google Drive Desktop sync folder.
// Anything that lands here gets uploaded to Drive automatically.
const CLOUD_MIRROR_DIR = 'C:\\AGIglassjo Drive\\BU';
const RETENTION_DAYS = 30;
const LOG_FILE    = path.join(BACKUP_DIR, 'backup.log');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  try { fs.appendFileSync(LOG_FILE, line); } catch(_) {}
}

function todayStamp() {
  // Local date YYYY-MM-DD (uses server's local timezone, fine since backups
  // run on this same machine)
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function backupDatabase(stamp) {
  const target = path.join(BACKUP_DIR, `agi-glass-${stamp}.db`);
  if (fs.existsSync(target)) {
    log(`DB backup for today already exists, overwriting: ${target}`);
    fs.unlinkSync(target);
  }

  if (!fs.existsSync(SOURCE_DB)) {
    log(`ERROR: source DB not found at ${SOURCE_DB}`);
    return null;
  }

  // SQLite's backup API gives us a consistent snapshot even while the server
  // has the DB open — it handles internal locking. Far safer than fs.copy.
  const sourceSize = fs.statSync(SOURCE_DB).size;
  log(`Backing up DB: ${(sourceSize / 1024 / 1024).toFixed(2)} MB → ${target}`);
  const t0 = Date.now();

  const db = new Database(SOURCE_DB, { readonly: true, fileMustExist: true });
  try {
    await db.backup(target);
  } finally {
    db.close();
  }

  const targetSize = fs.statSync(target).size;
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  log(`✓ DB backup: ${(targetSize / 1024 / 1024).toFixed(2)} MB in ${elapsed}s`);

  if (targetSize < sourceSize * 0.5) {
    log(`WARNING: DB backup is much smaller than source (${targetSize} vs ${sourceSize})`);
  }
  return target;
}

function backupUploads(stamp) {
  // Skip if uploads/ doesn't exist or is empty — no point making a 0-byte zip
  if (!fs.existsSync(UPLOADS_DIR)) {
    log(`No uploads/ folder, skipping uploads backup`);
    return null;
  }
  // Use recursive listing so files in subdirectories are counted too
  const fileCount = (() => {
    try {
      return fs.readdirSync(UPLOADS_DIR, { recursive: true })
        .filter(f => fs.statSync(path.join(UPLOADS_DIR, f)).isFile())
        .length;
    } catch (_) { return fs.readdirSync(UPLOADS_DIR).length; }
  })();
  if (!fileCount) {
    log(`uploads/ is empty, skipping uploads backup`);
    return null;
  }

  const target = path.join(BACKUP_DIR, `uploads-${stamp}.zip`);
  // If a zip from an earlier run today exists, try to remove it first so we
  // get a clean replacement. If it's locked (e.g. Drive Desktop is uploading
  // it, or someone has it open in Explorer's preview pane), fall through —
  // Compress-Archive's -Force flag will overwrite anyway.
  if (fs.existsSync(target)) {
    try { fs.unlinkSync(target); }
    catch (e) {
      log(`  Note: existing zip is locked (${e.code || 'EBUSY'}), -Force will overwrite`);
    }
  }

  // Use PowerShell's built-in Compress-Archive — no external dependencies.
  // Note: we point at the FOLDER (not folder/*) so subdirectories are
  // included recursively. Compress-Archive treats wildcards as flat-only.
  log(`Archiving uploads/ → ${target}`);
  const t0 = Date.now();
  try {
    execSync(
      `powershell -NoProfile -Command "Compress-Archive -Path '${UPLOADS_DIR}' -DestinationPath '${target}' -Force"`,
      { stdio: 'pipe' }
    );
    const targetSize = fs.statSync(target).size;
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    log(`✓ Uploads zip: ${(targetSize / 1024).toFixed(1)} KB (${fileCount} files) in ${elapsed}s`);
    return target;
  } catch (e) {
    log(`WARNING: failed to archive uploads: ${e.message}`);
    return null;
  }
}

// Copy the local backup files to the Drive sync folder so Google Drive picks
// them up and uploads them off-site. Uses straight file copy because the local
// files are already consistent snapshots — we just need a duplicate.
function mirrorToCloud(localPaths) {
  const valid = localPaths.filter(p => p && fs.existsSync(p));
  if (!valid.length) {
    log(`Nothing to mirror to cloud (no local backups produced this run)`);
    return;
  }
  if (!fs.existsSync(CLOUD_MIRROR_DIR)) {
    try {
      fs.mkdirSync(CLOUD_MIRROR_DIR, { recursive: true });
      log(`Created cloud mirror directory: ${CLOUD_MIRROR_DIR}`);
    } catch (e) {
      log(`WARNING: cloud mirror dir not available (${CLOUD_MIRROR_DIR}): ${e.message}`);
      log(`         — Drive Desktop may not be running. Skipping cloud mirror.`);
      return;
    }
  }
  for (const src of valid) {
    const dest = path.join(CLOUD_MIRROR_DIR, path.basename(src));
    try {
      fs.copyFileSync(src, dest);
      const size = fs.statSync(dest).size;
      log(`✓ Mirrored to Drive: ${path.basename(src)} (${(size / 1024 / 1024).toFixed(2)} MB)`);
    } catch (e) {
      log(`WARNING: failed to mirror ${src}: ${e.message}`);
    }
  }
}

function pruneOldBackups() {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  // Delete files matching either: agi-glass-YYYY-MM-DD.db or uploads-YYYY-MM-DD.zip
  // The strict pattern ensures we never accidentally wipe other files in the folder.
  const patterns = [
    /^agi-glass-\d{4}-\d{2}-\d{2}\.db$/,
    /^uploads-\d{4}-\d{2}-\d{2}\.zip$/
  ];
  // Prune from BOTH locations so the cloud mirror stays the same shape.
  const dirs = [BACKUP_DIR, CLOUD_MIRROR_DIR];
  let totalDeleted = 0;
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    let deleted = 0;
    for (const f of fs.readdirSync(dir)) {
      if (!patterns.some(p => p.test(f))) continue;
      const fp = path.join(dir, f);
      const stat = fs.statSync(fp);
      if (stat.mtimeMs < cutoff) {
        try {
          fs.unlinkSync(fp);
          deleted++;
          totalDeleted++;
          log(`  Pruned old backup: ${dir}\\${f}`);
        } catch (e) {
          log(`  WARNING: failed to prune ${fp}: ${e.message}`);
        }
      }
    }
    if (deleted) log(`Pruned ${deleted} from ${dir}`);
  }
  if (totalDeleted) log(`Pruned ${totalDeleted} backup(s) older than ${RETENTION_DAYS} days total`);
}

async function main() {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    log(`Created backup directory: ${BACKUP_DIR}`);
  }

  const stamp = todayStamp();
  log(`=== Backup run started for ${stamp} ===`);

  const dbPath = await backupDatabase(stamp);
  const zipPath = dbPath ? backupUploads(stamp) : null;
  if (dbPath) mirrorToCloud([dbPath, zipPath]);
  pruneOldBackups();

  log(`=== Backup run finished ===\n`);
}

main().catch(err => {
  log(`ERROR: ${err.message}`);
  log(err.stack || '');
  process.exit(1);
});


