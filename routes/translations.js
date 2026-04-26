// routes/translations.js — i18n key/value store for UI strings
const router = require('express').Router();
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');

// ── Schema ──────────────────────────────────────────────────────────────────
db.prepare(`
  CREATE TABLE IF NOT EXISTS translations (
    key     TEXT PRIMARY KEY,
    en      TEXT,
    ar      TEXT,
    section TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`).run();

// ── Public: read the full translation map (no auth — needed on login screen) ─
// Returns { ar: { "Dashboard": "لوحة التحكم", ... }, en: { ... } }
router.get('/', (req, res) => {
  try {
    const rows = db.prepare('SELECT key, en, ar FROM translations').all();
    const out = { en: {}, ar: {} };
    rows.forEach(r => {
      if (r.en) out.en[r.key] = r.en;
      if (r.ar) out.ar[r.key] = r.ar;
    });
    res.json(out);
  } catch (e) {
    console.error('[translations GET]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Admin: bulk upsert translations ──────────────────────────────────────────
// Body: { entries: [ { key, en, ar, section }, ... ] }
router.post('/', requireAuth, requireAdmin, (req, res) => {
  try {
    const entries = Array.isArray(req.body.entries) ? req.body.entries : [];
    if (!entries.length) return res.json({ ok: true, upserted: 0 });
    const stmt = db.prepare(`
      INSERT INTO translations (key, en, ar, section, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET
        en = COALESCE(excluded.en, translations.en),
        ar = COALESCE(excluded.ar, translations.ar),
        section = COALESCE(excluded.section, translations.section),
        updated_at = CURRENT_TIMESTAMP
    `);
    const txn = db.transaction((items) => {
      for (const e of items) {
        if (!e.key) continue;
        stmt.run(String(e.key), e.en || null, e.ar || null, e.section || null);
      }
    });
    txn(entries);
    res.json({ ok: true, upserted: entries.length });
  } catch (e) {
    console.error('[translations POST]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Admin: update a single translation ───────────────────────────────────────
router.put('/:key', requireAuth, requireAdmin, (req, res) => {
  try {
    const key = req.params.key;
    const { en, ar, section } = req.body || {};
    const existing = db.prepare('SELECT * FROM translations WHERE key=?').get(key);
    if (!existing) {
      db.prepare('INSERT INTO translations (key, en, ar, section) VALUES (?, ?, ?, ?)')
        .run(key, en || null, ar || null, section || null);
    } else {
      db.prepare(`
        UPDATE translations SET
          en = COALESCE(?, en),
          ar = COALESCE(?, ar),
          section = COALESCE(?, section),
          updated_at = CURRENT_TIMESTAMP
        WHERE key=?
      `).run(en || null, ar || null, section || null, key);
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('[translations PUT]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Admin: delete a translation ──────────────────────────────────────────────
router.delete('/:key', requireAuth, requireAdmin, (req, res) => {
  try {
    db.prepare('DELETE FROM translations WHERE key=?').run(req.params.key);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
