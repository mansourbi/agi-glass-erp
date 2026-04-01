// routes/glassfamilies.js
const router = require('express').Router();
const db     = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
router.use(requireAuth);

// Ensure table exists
try {
  db.prepare(`CREATE TABLE IF NOT EXISTS glass_families (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thickness INTEGER NOT NULL,
    type TEXT NOT NULL DEFAULT 'glass',
    color TEXT NOT NULL DEFAULT 'clear',
    label TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT (datetime('now'))
  )`).run();
  // Seed from raw_sheets if empty
  const cnt = db.prepare('SELECT COUNT(*) AS c FROM glass_families').get().c;
  if (cnt === 0) {
    // Try raw_sheets table first
    let seeded = false;
    try {
      const sheets = db.prepare('SELECT DISTINCT thickness, glass_type AS type, color FROM raw_sheets ORDER BY thickness').all();
      if (sheets.length) {
        const ins = db.prepare('INSERT OR IGNORE INTO glass_families (thickness,type,color,label,sort_order) VALUES (?,?,?,?,?)');
        const seen = new Set();
        sheets.forEach((s,i) => {
          const key = s.thickness+'|'+s.type+'|'+s.color;
          if (seen.has(key)) return; seen.add(key);
          const cap = t => t ? t.charAt(0).toUpperCase()+t.slice(1) : '';
          ins.run(s.thickness, s.type, s.color, s.thickness+'mm '+cap(s.color)+' '+cap(s.type), i);
        });
        seeded = true;
      }
    } catch(e2) { console.warn('[glassfam seed from raw_sheets]', e2.message); }

    // Always ensure these standard families exist
    if (!seeded) {
      const defaults = [
        [5,'glass','clear','5mm Clear Glass',0],
        [6,'glass','clear','6mm Clear Glass',1],
        [8,'glass','clear','8mm Clear Glass',2],
        [10,'glass','clear','10mm Clear Glass',3],
        [12,'glass','clear','12mm Clear Glass',4],
        [15,'glass','clear','15mm Clear Glass',5],
        [5,'mirror','antique','5mm Antique Mirror',6],
        [6,'mirror','antique','6mm Antique Mirror',7],
        [6,'mirror','black','6mm Black Mirror',8],
        [6,'mirror','bronze','6mm Bronze Mirror',9],
        [6,'lacobel','white','6mm Lacobel White',10],
        [6,'lacobel','black','6mm Lacobel Black',11],
        [6,'glass','low-iron','6mm Low-Iron Glass',12],
        [8,'glass','low-iron','8mm Low-Iron Glass',13],
        [10,'glass','low-iron','10mm Low-Iron Glass',14],
        [12,'glass','low-iron','12mm Low-Iron Glass',15],
      ];
      const ins = db.prepare('INSERT OR IGNORE INTO glass_families (thickness,type,color,label,sort_order) VALUES (?,?,?,?,?)');
      defaults.forEach(d => ins.run(...d));
    }
  }
} catch(e) { console.warn('[glass_families init]', e.message); }

// POST /reseed — admin force re-import from raw_sheets (deduplicates)
router.post('/reseed', requireAdmin, (req, res) => {
  try {
    // First remove any duplicates keeping lowest id per thickness|type|color
    const all = db.prepare('SELECT id, thickness, glass_type AS type, color FROM glass_families ORDER BY id').all();
    const seen = new Map();
    const toDelete = [];
    all.forEach(r => {
      const key = r.thickness+'|'+(r.type||'glass')+'|'+r.color;
      if (seen.has(key)) toDelete.push(r.id);
      else seen.set(key, r.id);
    });
    if (toDelete.length) {
      db.prepare('DELETE FROM glass_families WHERE id IN ('+toDelete.join(',')+')')  .run();
    }

    // Import from raw_sheets
    const sheets = db.prepare('SELECT DISTINCT thickness, glass_type AS type, color FROM raw_sheets ORDER BY thickness').all();
    const ins = db.prepare('INSERT OR IGNORE INTO glass_families (thickness,type,color,label,sort_order) VALUES (?,?,?,?,?)');
    const already = new Set(db.prepare('SELECT thickness||'|'||type||'|'||color AS k FROM glass_families').all().map(r=>r.k));
    let count = 0;
    sheets.forEach((s,i) => {
      const key = s.thickness+'|'+(s.type||'glass')+'|'+s.color;
      if (already.has(key)) return;
      const cap = t => t ? t.charAt(0).toUpperCase()+t.slice(1) : '';
      ins.run(s.thickness, s.type||'glass', s.color, s.thickness+'mm '+cap(s.color)+' '+cap(s.type||'glass'), i);
      count++; already.add(key);
    });
    res.json({ ok: true, removed_duplicates: toDelete.length, imported: count });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET all
router.get('/', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM glass_families ORDER BY sort_order,type,color,thickness').all();
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST create
router.post('/', requireAdmin, (req, res) => {
  try {
    const { thickness, type, color, label, sort_order } = req.body;
    if (!thickness || !type || !color) return res.status(400).json({ error: 'thickness, type, color required' });
    const lbl = label || (thickness+'mm '+color.charAt(0).toUpperCase()+color.slice(1)+' '+type.charAt(0).toUpperCase()+type.slice(1));
    const r = db.prepare('INSERT INTO glass_families (thickness,type,color,label,sort_order) VALUES (?,?,?,?,?)').run(+thickness, type, color, lbl, sort_order||0);
    res.status(201).json(db.prepare('SELECT * FROM glass_families WHERE id=?').get(r.lastInsertRowid));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT update
router.put('/:id', requireAdmin, (req, res) => {
  try {
    const { thickness, type, color, label, active, sort_order } = req.body;
    const lbl = label || (thickness+'mm '+color.charAt(0).toUpperCase()+color.slice(1)+' '+type.charAt(0).toUpperCase()+type.slice(1));
    db.prepare('UPDATE glass_families SET thickness=?,type=?,color=?,label=?,active=?,sort_order=? WHERE id=?')
      .run(+thickness, type, color, lbl, active===false?0:1, sort_order||0, +req.params.id);
    res.json(db.prepare('SELECT * FROM glass_families WHERE id=?').get(+req.params.id));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE
router.delete('/:id', requireAdmin, (req, res) => {
  try {
    db.prepare('DELETE FROM glass_families WHERE id=?').run(+req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
