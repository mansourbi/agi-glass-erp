// routes/access.js - Roles & Privileges API (R-1: foundation + read endpoints)
const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const P = require('../middleware/permissions');

// schema + seed on load (runs during startup, before serving traffic -> wedge-safe)
try { P.ensureSchema(); P.seedRolesIfEmpty(); }
catch (e) { console.error('[access] schema/seed failed:', e.message); }

router.use(requireAuth);

// GET /api/access/me - the signed-in user's resolved permissions (drives frontend gating)
router.get('/me', (req, res) => {
  try {
    const p = P.resolvePerms(req.user.id);
    res.json({
      user: { id: req.user.id, name: req.user.name, role_string: req.user.role },
      role: p.role ? { id: p.role.id, name: p.role.name, superadmin: !!p.role.superadmin }
                   : (p.legacy ? { id: null, name: '(legacy: ' + req.user.role + ')', superadmin: false } : null),
      superadmin: p.superadmin,
      portal_access: p.portal,
      workerapp_access: p.workerapp,
      permissions: p.superadmin ? P.ALL_KEYS : Array.from(p.keys)
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/access/catalog - the full permission catalog (for the admin UI in R-4)
router.get('/catalog', (req, res) => {
  res.json({ catalog: P.CATALOG, groups: Object.keys(P.GROUPS) });
});

module.exports = router;

