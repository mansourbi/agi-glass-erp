// routes/layout.js — Factory floor layout (single document, key-value)
//
// One row in factory_layout (id=1) holds a JSON document with:
//   { spaces: [{id,x,y,w,h,name}],
//     objects: [{id,type:rect|square|circle|text,x,y,w,h,r,fill,label,fontSize}] }
//
// All coordinates in METERS (from origin), snapped to 0.5m on the client.
// The whole document is GET'd and PUT'n atomically — there are no per-object
// endpoints because (a) the doc is small, (b) atomic save prevents two admins
// from clobbering each other's edits mid-drag.

const router = require('express').Router();
const db     = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
router.use(requireAuth);

try {
  db.prepare(`CREATE TABLE IF NOT EXISTS factory_layout (
    id INTEGER PRIMARY KEY,
    doc TEXT NOT NULL DEFAULT '{}',
    updated_at DATETIME DEFAULT (datetime('now')),
    updated_by TEXT
  )`).run();
  // Seed with empty doc so GET always returns something reasonable
  db.prepare(`INSERT OR IGNORE INTO factory_layout (id, doc) VALUES (1, ?)`).run(
    JSON.stringify({ spaces: [], objects: [] })
  );
} catch(e) { console.warn('[factory_layout init]', e.message); }

// GET /api/layout — returns the saved layout document
router.get('/', (req, res) => {
  try {
    const r = db.prepare('SELECT doc, updated_at, updated_by FROM factory_layout WHERE id=1').get();
    let doc = { spaces: [], objects: [] };
    if (r && r.doc) {
      try { doc = JSON.parse(r.doc); } catch(_) {}
    }
    // Defensive: ensure both arrays exist even if doc was malformed
    if (!Array.isArray(doc.spaces))  doc.spaces  = [];
    if (!Array.isArray(doc.objects)) doc.objects = [];
    res.json({ doc, updated_at: r?.updated_at || null, updated_by: r?.updated_by || null });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/layout — replaces the saved layout. Requires admin.
//
// Validates: doc.spaces and doc.objects are arrays. Caps total size at 200KB
// of JSON to prevent runaway bloat (a generous limit — typical layouts are
// well under 10KB).
router.put('/', requireAdmin, (req, res) => {
  try {
    const doc = req.body && req.body.doc;
    if (!doc || typeof doc !== 'object') {
      return res.status(400).json({ error: 'doc object required' });
    }
    if (!Array.isArray(doc.spaces) || !Array.isArray(doc.objects)) {
      return res.status(400).json({ error: 'doc.spaces and doc.objects must be arrays' });
    }
    const json = JSON.stringify(doc);
    if (json.length > 200_000) {
      return res.status(413).json({ error: 'Layout document too large (max 200KB)' });
    }
    const who = (req.user && req.user.name) || 'admin';
    db.prepare(`UPDATE factory_layout SET doc=?, updated_at=datetime('now'), updated_by=? WHERE id=1`)
      .run(json, who);
    res.json({ ok: true, updated_by: who });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
