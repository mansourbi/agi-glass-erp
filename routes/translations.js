// routes/translations.js — i18n key/value store for UI strings
//
// Why this file looks the way it does:
//   The previous version used `COALESCE(?, ar)` with `ar || null` from the
//   request body. That collapsed empty strings into NULL, so UPDATEs that
//   tried to clear a translation silently kept the old value. Worse, all
//   responses were `{ok: true}` regardless, so the UI couldn't tell.
//
//   This version distinguishes three cases:
//     - field NOT in request body  → don't touch it
//     - field present and empty    → store empty string (clears the value)
//     - field present and non-empty → store as-is
//   And every write returns the row so the client can verify.

const router = require('express').Router();
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');

db.prepare(`
  CREATE TABLE IF NOT EXISTS translations (
    key     TEXT PRIMARY KEY,
    en      TEXT,
    ar      TEXT,
    section TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`).run();

// Public read — needed before login so the SIGN IN button can be Arabic.
router.get('/', (req, res) => {
  try {
    const rows = db.prepare('SELECT key, en, ar FROM translations').all();
    const out = { en: {}, ar: {} };
    rows.forEach(r => {
      if (r.en != null) out.en[r.key] = r.en;
      if (r.ar != null) out.ar[r.key] = r.ar;
    });
    res.json(out);
  } catch (e) {
    console.error('[translations GET]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// List endpoint with metadata (used by the editor — needs section + updated_at)
router.get('/list', requireAuth, (req, res) => {
  try {
    const rows = db.prepare('SELECT key, en, ar, section, updated_at FROM translations ORDER BY key').all();
    res.json(rows);
  } catch (e) {
    console.error('[translations GET /list]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Bulk upsert — used by seed scripts. NULL means "don't touch".
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
        stmt.run(String(e.key), e.en ?? null, e.ar ?? null, e.section ?? null);
      }
    });
    txn(entries);
    res.json({ ok: true, upserted: entries.length });
  } catch (e) {
    console.error('[translations POST]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Single-row upsert — used by the inline editor in Settings → Translations.
//
// Request body keys: en, ar, section.
// Semantics:
//   - Key NOT present in body            → leave that column unchanged
//   - Key present (even if "")           → write that value as-is
// Returns the updated row so the client can confirm what was stored.
router.put('/:key', requireAuth, requireAdmin, (req, res) => {
  try {
    const key = req.params.key;
    if (!key) return res.status(400).json({ error: 'key required' });
    const body = req.body || {};

    const existing = db.prepare('SELECT * FROM translations WHERE key=?').get(key);
    if (!existing) {
      // INSERT path — fields not in body default to NULL
      db.prepare('INSERT INTO translations (key, en, ar, section) VALUES (?, ?, ?, ?)').run(
        key,
        Object.prototype.hasOwnProperty.call(body, 'en')      ? String(body.en      ?? '') : null,
        Object.prototype.hasOwnProperty.call(body, 'ar')      ? String(body.ar      ?? '') : null,
        Object.prototype.hasOwnProperty.call(body, 'section') ? String(body.section ?? '') : null,
      );
    } else {
      // UPDATE path — only set columns that were sent in the body
      const sets = [];
      const args = [];
      if (Object.prototype.hasOwnProperty.call(body, 'en'))      { sets.push('en = ?');      args.push(String(body.en      ?? '')); }
      if (Object.prototype.hasOwnProperty.call(body, 'ar'))      { sets.push('ar = ?');      args.push(String(body.ar      ?? '')); }
      if (Object.prototype.hasOwnProperty.call(body, 'section')) { sets.push('section = ?'); args.push(String(body.section ?? '')); }
      if (!sets.length) {
        return res.json({ ok: true, row: existing, note: 'no fields to update' });
      }
      sets.push('updated_at = CURRENT_TIMESTAMP');
      args.push(key);
      db.prepare(`UPDATE translations SET ${sets.join(', ')} WHERE key = ?`).run(...args);
    }

    const row = db.prepare('SELECT key, en, ar, section, updated_at FROM translations WHERE key=?').get(key);
    res.json({ ok: true, row });
  } catch (e) {
    console.error('[translations PUT]', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:key', requireAuth, requireAdmin, (req, res) => {
  try {
    const r = db.prepare('DELETE FROM translations WHERE key=?').run(req.params.key);
    res.json({ ok: true, deleted: r.changes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
