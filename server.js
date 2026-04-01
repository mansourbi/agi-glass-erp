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

// ── Uploads directory — served as static files ────────────
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use('/uploads', express.static(uploadsDir));

// ── File upload endpoint ───────────────────────────────────
const multer = require('multer');
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const orderRef = (req.params.orderRef || 'misc').replace(/[^a-zA-Z0-9_\-]/g, '_');
    const dir = path.join(uploadsDir, orderRef);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ts = Date.now();
    const safe = file.originalname.replace(/[^a-zA-Z0-9._\-]/g, '_');
    cb(null, ts + '_' + safe);
  }
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });

// POST /api/uploads/:orderRef
app.post('/api/uploads/:orderRef', requireAuth, upload.array('files', 20), (req, res) => {
  try {
    const orderRef = (req.params.orderRef || 'misc').replace(/[^a-zA-Z0-9_\-]/g, '_');
    const result = (req.files || []).map(f => ({
      originalName: f.originalname,
      filename:     f.filename,
      path:         '/uploads/' + orderRef + '/' + f.filename,
      size:         f.size,
      type:         f.mimetype
    }));
    res.json({ ok: true, files: result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/uploads/:orderRef/:filename
app.delete('/api/uploads/:orderRef/:filename', requireAuth, (req, res) => {
  try {
    const orderRef = req.params.orderRef.replace(/[^a-zA-Z0-9_\-]/g, '_');
    const filename = req.params.filename.replace(/[^a-zA-Z0-9._\-]/g, '_');
    const filePath = path.join(uploadsDir, orderRef, filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
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
    for (const [k,v] of Object.entries(obj)) { if(v===null||v===undefined||v==='null') { db.prepare('DELETE FROM config WHERE key=?').run(k); } else { upsert.run(k, String(v)); } }
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

// POST /api/uploads/rename-folder — rename new-order → actual order ref
app.post('/api/uploads/rename-folder', requireAuth, (req, res) => {
  try {
    const { from, to } = req.body;
    if (!from || !to) return res.status(400).json({ error: 'from and to required' });
    const safeFrom = from.replace(/[^a-zA-Z0-9_\-]/g, '_');
    const safeTo   = to.replace(/[^a-zA-Z0-9_\-]/g, '_');
    const fromPath = path.join(uploadsDir, safeFrom);
    const toPath   = path.join(uploadsDir, safeTo);
    if (fs.existsSync(fromPath)) {
      if (fs.existsSync(toPath)) {
        // Merge: move all files from fromPath to toPath
        fs.readdirSync(fromPath).forEach(f => {
          fs.renameSync(path.join(fromPath, f), path.join(toPath, f));
        });
        fs.rmdirSync(fromPath);
      } else {
        fs.renameSync(fromPath, toPath);
      }
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
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
const certFile = path.join(__dirname, '192.168.1.19+2.pem');
const keyFile  = path.join(__dirname, '192.168.1.19+2-key.pem');

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
    console.log(`  ║  https://192.168.1.19:${HTTPS_PORT}   (LAN) ║`);
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
