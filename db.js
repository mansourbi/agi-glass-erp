// db.js — SQLite connection + auto-create schema
const path    = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'agi-glass.db');
const db = new Database(DB_PATH);

// Performance settings
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL');

// ── Create all tables ────────────────────────────────────────
db.exec(`

-- CUSTOMERS
CREATE TABLE IF NOT EXISTS customers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  company     TEXT,
  phone       TEXT NOT NULL,
  email       TEXT,
  address     TEXT,
  notes       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- WORKERS
CREATE TABLE IF NOT EXISTS workers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  email       TEXT NOT NULL UNIQUE,
  pass_hash   TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'worker',
  processes   TEXT NOT NULL DEFAULT '[]',
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ORDERS
CREATE TABLE IF NOT EXISTS orders (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  num         TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  date        TEXT NOT NULL,
  extref      TEXT,
  notes       TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',
  attachments TEXT NOT NULL DEFAULT '[]',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ORDER ITEMS
CREATE TABLE IF NOT EXISTS order_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id    INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  code        TEXT NOT NULL,
  w           REAL NOT NULL,
  h           REAL NOT NULL,
  thickness   REAL NOT NULL DEFAULT 6,
  glass_type  TEXT NOT NULL DEFAULT 'glass',
  color       TEXT NOT NULL DEFAULT 'clear',
  qty         INTEGER NOT NULL DEFAULT 1,
  processes   TEXT NOT NULL DEFAULT '[]',
  bevel_mm    REAL DEFAULT 0,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  piece_uids  TEXT NOT NULL DEFAULT '[]',
  start_serial INTEGER NOT NULL DEFAULT 1
);

-- RAW SHEET CATALOG
CREATE TABLE IF NOT EXISTS raw_sheets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL,
  glass_type  TEXT NOT NULL DEFAULT 'float',
  color       TEXT NOT NULL DEFAULT 'clear',
  thickness   REAL NOT NULL,
  w           REAL NOT NULL,
  h           REAL NOT NULL,
  company     TEXT,
  origin      TEXT,
  notes       TEXT,
  stock_qty   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- OPTIMIZATION FILES
CREATE TABLE IF NOT EXISTS opt_files (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  raw_sheet_id  INTEGER REFERENCES raw_sheets(id),
  raw_sheet_snap TEXT,
  comp_w        REAL NOT NULL DEFAULT 0,
  comp_h        REAL NOT NULL DEFAULT 0,
  cut_pieces    TEXT NOT NULL DEFAULT '[]',
  manual_pieces TEXT NOT NULL DEFAULT '[]',
  results       TEXT,
  order_ids     TEXT NOT NULL DEFAULT '[]',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at  TEXT
);

-- LABEL ITEMS (one row per physical glass piece)
CREATE TABLE IF NOT EXISTS label_items (
  uid         TEXT PRIMARY KEY,
  code        TEXT NOT NULL,
  w           REAL NOT NULL,
  h           REAL NOT NULL,
  thickness   REAL NOT NULL DEFAULT 6,
  glass_type  TEXT NOT NULL DEFAULT 'glass',
  color       TEXT NOT NULL DEFAULT 'clear',
  processes   TEXT NOT NULL DEFAULT '[]',
  bevel_mm    REAL DEFAULT 0,
  order_id    INTEGER REFERENCES orders(id),
  order_num   TEXT,
  opt_file_id INTEGER REFERENCES opt_files(id),
  sheet_idx   INTEGER,
  cut_type    TEXT NOT NULL DEFAULT 'machine',
  date        TEXT NOT NULL DEFAULT (date('now')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- SCAN LOG
CREATE TABLE IF NOT EXISTS scan_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  worker_id   INTEGER NOT NULL REFERENCES workers(id),
  worker_name TEXT,
  piece_uid   TEXT NOT NULL,
  process     TEXT NOT NULL,
  action      TEXT NOT NULL,
  order_num   TEXT,
  ts          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_scan_piece  ON scan_log(piece_uid);
CREATE INDEX IF NOT EXISTS idx_scan_worker ON scan_log(worker_id);
CREATE INDEX IF NOT EXISTS idx_scan_ts     ON scan_log(ts);

-- PURCHASES
CREATE TABLE IF NOT EXISTS purchases (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  sheet_id    INTEGER NOT NULL REFERENCES raw_sheets(id),
  qty         INTEGER NOT NULL,
  date        TEXT NOT NULL,
  notes       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- CONFIG
CREATE TABLE IF NOT EXISTS config (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO config (key, value) VALUES
  ('factory_name', 'AGI Glass'),
  ('app_version', '1.0');

`);

console.log('[DB] SQLite ready:', DB_PATH);
module.exports = db;
