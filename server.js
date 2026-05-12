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
app.use('/api/deliveries', require('./routes/deliveries'));
app.use('/api/slots',      require('./routes/slots'));
app.use('/api/gsheets',    require('./routes/gsheets'));
app.use('/api/layout',     require('./routes/layout'));
app.use('/api/purchasing', require('./routes/purchasing'));
app.use('/api/holidays',  require('./routes/holidays'));
app.use('/api/extprocesses', require('./routes/external_processes'));
app.use('/api/factories',    require('./routes/factories'));
app.use('/api/translations', require('./routes/translations'));

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

// Allow updating supplier on locked POs
app.patch('/api/purchasing/:id/supplier', requireAuth, (req, res) => {
  try {
    const { supplier_id, supplier_name, supplier_country } = req.body;
    const po = db.prepare('SELECT id FROM purchase_orders WHERE id=?').get(+req.params.id);
    if (!po) return res.status(404).json({ error: 'PO not found' });
    db.prepare('UPDATE purchase_orders SET supplier_id=?, supplier_name=?, supplier_country=? WHERE id=?')
      .run(supplier_id||null, supplier_name||'', supplier_country||'', +req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Public config endpoint — only exposes non-sensitive display fields (logo, factory name)
app.get('/api/config/public', (req, res) => {
  try {
    const rows = db.prepare("SELECT key,value FROM config WHERE key IN ('factory','factory_logo','factory_logo_dark')").all();
    res.json(Object.fromEntries(rows.map(r=>[r.key,r.value])));
  } catch(e) { res.json({}); }
});

// Serve logo publicly — writes base64 logo from config to a static file on save
app.get('/logo.png', (req, res) => {
  try {
    const row = db.prepare("SELECT value FROM config WHERE key='factory_logo'").get();
    if (!row || !row.value) return res.status(404).send('No logo');
    const b64 = row.value.replace(/^data:image\/\w+;base64,/, '');
    const buf = Buffer.from(b64, 'base64');
    // Detect mime type
    const mime = row.value.startsWith('data:image/png') ? 'image/png' :
                 row.value.startsWith('data:image/svg') ? 'image/svg+xml' : 'image/jpeg';
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(buf);
  } catch(e) { res.status(500).send(e.message); }
});

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

// ── Google Sheets Auto-Sync (8am–5pm, top of every hour) ────────────────────
(function scheduleGSheetsSync() {
  function runSync() {
    const now = new Date();
    const hour = now.getHours();
    if (hour >= 8 && hour < 17) {
      console.log('[gsheets cron] Auto-syncing at ' + now.toLocaleTimeString());
      const http = require('http');
      const opts = {
        hostname: '127.0.0.1', port: process.env.PORT || 3000,
        path: '/api/gsheets/sync', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-cron': '1' }
      };
      const req = http.request(opts, function(res) {
        let data = '';
        res.on('data', function(d) { data += d; });
        res.on('end', function() {
          try {
            const r = JSON.parse(data);
            const summary = (r.synced || []).map(function(s) { return s.customer + ': ' + s.rows + ' rows'; });
            console.log('[gsheets cron] Done:', summary.join(', ') || 'no customers synced');
          } catch(e) { console.warn('[gsheets cron] Parse error:', e.message); }
        });
      });
      req.on('error', function(e) { console.warn('[gsheets cron] Error:', e.message); });
      req.write('{}'); req.end();
    }
  }
  function runDeliveriesSync() {
    const now = new Date();
    const hour = now.getHours();
    if (hour >= 8 && hour < 17) {
      const opts2 = {
        hostname: '127.0.0.1', port: process.env.PORT || 3000,
        path: '/api/gsheets/sync-deliveries', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-cron': '1' }
      };
      const req2 = http.request(opts2, function(res2) {
        let data2 = '';
        res2.on('data', function(d) { data2 += d; });
        res2.on('end', function() { console.log('[gsheets cron] Deliveries synced'); });
      });
      req2.on('error', function(e) { console.warn('[gsheets cron deliveries]', e.message); });
      req2.write('{}'); req2.end();
    }
  }
  // Fire at the top of every hour, check window inside runSync
  function scheduleNextHour() {
    const now = new Date();
    const msUntilNextHour = (60 - now.getMinutes()) * 60000 - now.getSeconds() * 1000 - now.getMilliseconds() + 100;
    setTimeout(function() {
      runSync();
      runDeliveriesSync();
      scheduleNextHour(); // re-schedule after each fire to stay aligned to top of hour
    }, msUntilNextHour);
  }
  setTimeout(scheduleNextHour, 5000); // small delay on startup
})();

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
