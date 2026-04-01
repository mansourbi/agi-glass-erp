// server.js — AGI Glass Factory Management System
// env loaded from .env if present
try { require('dotenv').config(); } catch(e) {}
const express = require('express');
const cors    = require('cors');
const morgan  = require('morgan');
const path    = require('path');
const fs      = require('fs');
const https   = require('https');
const http    = require('http');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(morgan('dev'));

// ── Static files (HTML apps served from /public) ─────────
app.use(express.static(path.join(__dirname, 'public')));

// ── API Routes ────────────────────────────────────────────
// Public QR scan page
app.use('/piece', require('./routes/scan'));

app.use('/api/auth',      require('./routes/auth'));
app.use('/api/customers', require('./routes/customers'));
app.use('/api/orders',    require('./routes/orders'));
app.use('/api/workers',   require('./routes/workers'));
app.use('/api/labels',    require('./routes/labels'));
app.use('/api/rawsheets', require('./routes/rawsheets'));
app.use('/api/optfiles',  require('./routes/optfiles'));
app.use('/api/reports',   require('./routes/reports'));
app.use('/api/purchases', require('./routes/purchases'));
app.use('/api/attendance', require('./routes/attendance'));
app.use('/api/hr', require('./routes/hr'));
app.use('/api/glassfamilies', require('./routes/glassfamilies'));
app.use('/api/finalproducts', require('./routes/finalproducts'));
app.use('/api/fpfields', require('./routes/fpfields'));
app.use('/api/remnants', require('./routes/remnants'));

// ── Config ────────────────────────────────────────────────
const { requireAuth, requireAdmin } = require('./middleware/auth');
const db = require('./db');

// ── DB Migrations (safe — ignore if column already exists) ──
const migrations = [
  "ALTER TABLE workers ADD COLUMN device_id TEXT",
  "ALTER TABLE workers ADD COLUMN device_status TEXT",
  "ALTER TABLE workers ADD COLUMN device_registered_at TEXT",
];
for (const sql of migrations) {
  try { db.prepare(sql).run(); } catch(e) { /* column exists */ }
}

app.get('/api/config', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT key,value FROM config').all();
  res.json(Object.fromEntries(rows.map(r => [r.key, r.value])));
});

app.put('/api/config', requireAuth, requireAdmin, (req, res) => {
  const upsert = db.prepare(`
    INSERT INTO config(key,value,updated_at) VALUES(?,?,datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at
  `);
  const run = db.transaction(obj => {
    for (const [k,v] of Object.entries(obj)) upsert.run(k, String(v));
  });
  run(req.body);
  res.json({ ok: true });
});

// ── Health check ──────────────────────────────────────────
app.get('/api/health', (req, res) => {
  try {
    db.prepare('SELECT 1').get();
    res.json({ status: 'ok', ts: new Date().toISOString(), db: 'connected' });
  } catch(e) {
    res.status(503).json({ status: 'error', db: 'disconnected' });
  }
});

// ── 404 ───────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Not found: ' + req.path }));

// ── Error handler ─────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error('[ERROR]', err.message);
  res.status(500).json({ error: err.message });
});

// ── Start ─────────────────────────────────────────────────
const HTTPS_PORT = process.env.HTTPS_PORT || 3444;
const certFile = path.join(__dirname, '192.168.1.15+2.pem');
const keyFile  = path.join(__dirname, '192.168.1.15+2-key.pem');

if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
  // HTTPS — required for camera access on mobile
  const sslOptions = {
    cert: fs.readFileSync(certFile),
    key:  fs.readFileSync(keyFile)
  };
  const httpsServer = https.createServer(sslOptions, app);
  httpsServer.on('error', (e) => console.error('[HTTPS]', e.message));
  httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
    console.log('\n  ╔═══════════════════════════════════════╗');
    console.log(`  ║  AGI Glass — Server running           ║`);
    console.log(`  ║  https://localhost:${HTTPS_PORT}            ║`);
    console.log(`  ║  https://192.168.1.15:${HTTPS_PORT}   (LAN) ║`);
    console.log('  ╚═══════════════════════════════════════╝\n');
  });
  // Also keep HTTP for desktop
  const httpServer2 = http.createServer(app);
  httpServer2.on('error', (e) => console.error('[HTTP]', e.message));
  httpServer2.listen(PORT, '0.0.0.0', () => {
    console.log(`  [HTTP]  http://localhost:${PORT} (desktop only)`);
  });
} else {
  // HTTP fallback if no cert found
  const httpFallback = http.createServer(app);
  httpFallback.on('error', (e) => console.error('[HTTP]', e.message));
  httpFallback.listen(PORT, '0.0.0.0', () => {
    console.log('\n  ╔═══════════════════════════════════════╗');
    console.log(`  ║  AGI Glass — Server running           ║`);
    console.log(`  ║  http://localhost:${PORT}               ║`);
    console.log(`  ║  http://0.0.0.0:${PORT}  (LAN)          ║`);
    console.log(`  ║  NOTE: No SSL cert — camera blocked   ║`);
    console.log('  ╚═══════════════════════════════════════╝\n');
  });
}
