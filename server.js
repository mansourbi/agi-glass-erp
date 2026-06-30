// server.js Ã¢â‚¬â€ AGI Glass Factory Management System
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

// Ã¢â€â‚¬Ã¢â€â‚¬ Middleware Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(morgan('dev'));

// Ã¢â€â‚¬Ã¢â€â‚¬ Audit logging (records every write + login; reads are not logged here) Ã¢â€â‚¬Ã¢â€â‚¬
const auditDb = require('./db');
auditDb.exec(`
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    source TEXT, user_id INTEGER, user_name TEXT, user_role TEXT,
    action TEXT, section TEXT, table_name TEXT, record_id TEXT,
    method TEXT, path TEXT, detail TEXT, status INTEGER, ip TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);
  CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id);
  CREATE INDEX IF NOT EXISTS idx_audit_section ON audit_log(section);
`);
const _auditStmt = auditDb.prepare(`INSERT INTO audit_log
  (source,user_id,user_name,user_role,action,section,table_name,record_id,method,path,detail,status,ip)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const _AUDIT_SECTION = {
  auth:'Auth', customers:'Customers', orders:'Orders', workers:'Workers', labels:'Labels',
  rawsheets:'Raw Sheets', optfiles:'Optimizations', reports:'Reports', purchases:'Purchases',
  attendance:'Attendance', hr:'HR', glassfamilies:'Glass Families', finalproducts:'Final Products',
  fpfields:'FP Fields', remnants:'Remnants', deliveries:'Deliveries', slots:'Slots',
  gsheets:'Google Sheets', layout:'Layout', purchasing:'Purchasing', holidays:'Holidays',
  extprocesses:'Ext Processes', factories:'Factories', translations:'Translations',
  config:'Config', piece:'QR Scan'
};
const _AUDIT_METHOD = { POST:'create', PUT:'update', PATCH:'update', DELETE:'delete' };
function _auditRedact(b){
  if(!b || typeof b!=='object') return b;
  const c = Array.isArray(b) ? b.slice() : {...b};
  for(const k of Object.keys(c)){ if(/pass|pwd|token|secret|hash/i.test(k)) c[k]='***'; }
  return c;
}
app.use((req, res, next) => {
  const p = req.path || '';
  if(!(p.startsWith('/api/') || p.startsWith('/piece'))) return next(); // skip static assets
  if(p.startsWith('/api/audit') || p === '/api/health')   return next(); // skip self + health
  if(req.headers['x-internal-cron'])                      return next(); // skip gsheets cron
  const _json = res.json.bind(res);
  res.json = (body) => { try{ res.locals.__auditBody = body; }catch(e){} return _json(body); };
  res.on('finish', () => {
    try{
      const method  = req.method;
      const isLogin = (p === '/api/auth/login');
      const action  = isLogin ? 'login' : _AUDIT_METHOD[method];
      if(!action) return;                       // only writes (+ login); reads ignored
      const u = req.user || {};
      let uid = u.id ?? null, uname = u.name ?? null, urole = u.role ?? null;
      const rb = res.locals.__auditBody;
      if(isLogin){
        if(res.statusCode < 400 && rb && rb.worker){ uid = rb.worker.id; uname = rb.worker.name; urole = rb.worker.role; }
        else { uid = null; uname = (req.body && req.body.email) || null; urole = null; }
      }
      const seg = p.split('/').filter(Boolean);
      const key = (seg[0]==='api') ? (seg[1]||'') : (seg[0]||'');
      const section = _AUDIT_SECTION[key] || key;
      let record_id = null;
      const num = seg.find(s=>/^\d+$/.test(s));
      if(num) record_id = num;
      else if(rb && (rb.id || (rb.worker && rb.worker.id))) record_id = String(rb.id || rb.worker.id);
      const source = ((req.headers['x-client']||'').toLowerCase())
                     || (/worker/i.test(req.headers['referer']||'') ? 'worker' : 'portal');
      const detail = (method==='DELETE' || isLogin) ? null : JSON.stringify(_auditRedact(req.body)||{});
      _auditStmt.run(source, uid, uname, urole, action, section, key, record_id,
                     method, p, detail, res.statusCode, (req.ip || (req.socket && req.socket.remoteAddress) || ''));
    }catch(e){ /* logging must never break a request */ }
  });
  next();
});

// Ã¢â€â‚¬Ã¢â€â‚¬ Static files (HTML apps served from /public) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
app.use(express.static(path.join(__dirname, 'public')));
app.use(require('./middleware/enforce'));

// Ã¢â€â‚¬Ã¢â€â‚¬ API Routes Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
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
app.use('/api/customerprices', require('./routes/customerprices'));
app.use('/api/orderpricing', require('./routes/orderpricing'));
app.use('/api/pricing2', require('./routes/pricing2'));
app.use('/api/pricing_admin', require('./routes/pricing_admin'));
app.use('/api/access', require('./routes/access'));
app.use('/api/sheetowner', require('./routes/sheetowner'));
app.use('/api/fpfields', require('./routes/fpfields'));
app.use('/api/remnants', require('./routes/remnants'));
app.use('/api/deliveries', require('./routes/deliveries'));
app.use('/api/slots',      require('./routes/slots'));
app.use('/api/cutting',    require('./routes/cutting'));
app.use('/api/gsheets',    require('./routes/gsheets'));
app.use('/api/layout',     require('./routes/layout'));
app.use('/api/purchasing', require('./routes/purchasing'));
app.use('/api/holidays',  require('./routes/holidays'));
app.use('/api/extprocesses', require('./routes/external_processes'));
app.use('/api/factories',    require('./routes/factories'));
app.use('/api/translations', require('./routes/translations'));
app.use('/api/audit',        require('./routes/audit'));

// Ã¢â€â‚¬Ã¢â€â‚¬ Config Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
const { requireAuth, requireAdmin } = require('./middleware/auth');
const db = require('./db');

// Ã¢â€â‚¬Ã¢â€â‚¬ DB Migrations (safe Ã¢â‚¬â€ ignore if column already exists) Ã¢â€â‚¬Ã¢â€â‚¬
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

// Public config endpoint Ã¢â‚¬â€ only exposes non-sensitive display fields (logo, factory name)
app.get('/api/config/public', (req, res) => {
  try {
    const rows = db.prepare("SELECT key,value FROM config WHERE key IN ('factory','factory_logo','factory_logo_dark')").all();
    res.json(Object.fromEntries(rows.map(r=>[r.key,r.value])));
  } catch(e) { res.json({}); }
});

// Serve logo publicly Ã¢â‚¬â€ writes base64 logo from config to a static file on save
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

// Ã¢â€â‚¬Ã¢â€â‚¬ Health check Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
app.get('/api/health', (req, res) => {
  try {
    db.prepare('SELECT 1').get();
    res.json({ status: 'ok', ts: new Date().toISOString(), db: 'connected' });
  } catch(e) {
    res.status(503).json({ status: 'error', db: 'disconnected' });
  }
});

// Ã¢â€â‚¬Ã¢â€â‚¬ Google Sheets Auto-Sync (8amÃ¢â‚¬â€œ5pm, top of every hour) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
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

// Ã¢â€â‚¬Ã¢â€â‚¬ 404 Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
app.use((req, res) => res.status(404).json({ error: 'Not found: ' + req.path }));

// Ã¢â€â‚¬Ã¢â€â‚¬ Error handler Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
app.use((err, req, res, _next) => {
  console.error('[ERROR]', err.message);
  res.status(500).json({ error: err.message });
});

// Ã¢â€â‚¬Ã¢â€â‚¬ Start Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
const HTTPS_PORT = process.env.HTTPS_PORT || 3444;
const certFile = path.join(__dirname, '192.168.1.15+2.pem');
const keyFile  = path.join(__dirname, '192.168.1.15+2-key.pem');

if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
  // HTTPS Ã¢â‚¬â€ required for camera access on mobile
  const sslOptions = {
    cert: fs.readFileSync(certFile),
    key:  fs.readFileSync(keyFile)
  };
  const httpsServer = https.createServer(sslOptions, app);
  httpsServer.on('error', (e) => console.error('[HTTPS]', e.message));
  httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
    console.log('\n  Ã¢â€¢â€Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢â€”');
    console.log(`  Ã¢â€¢â€˜  AGI Glass Ã¢â‚¬â€ Server running           Ã¢â€¢â€˜`);
    console.log(`  Ã¢â€¢â€˜  https://localhost:${HTTPS_PORT}            Ã¢â€¢â€˜`);
    console.log(`  Ã¢â€¢â€˜  https://192.168.1.15:${HTTPS_PORT}   (LAN) Ã¢â€¢â€˜`);
    console.log('  Ã¢â€¢Å¡Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â\n');
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
    console.log('\n  Ã¢â€¢â€Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢â€”');
    console.log(`  Ã¢â€¢â€˜  AGI Glass Ã¢â‚¬â€ Server running           Ã¢â€¢â€˜`);
    console.log(`  Ã¢â€¢â€˜  http://localhost:${PORT}               Ã¢â€¢â€˜`);
    console.log(`  Ã¢â€¢â€˜  http://0.0.0.0:${PORT}  (LAN)          Ã¢â€¢â€˜`);
    console.log(`  Ã¢â€¢â€˜  NOTE: No SSL cert Ã¢â‚¬â€ camera blocked   Ã¢â€¢â€˜`);
    console.log('  Ã¢â€¢Å¡Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â\n');
  });
}
