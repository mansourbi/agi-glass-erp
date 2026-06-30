// middleware/enforce.js - centralized backend permission enforcement (R-2)
// Mounted once at app level, before the API routers. Superadmin bypasses;
// UNMAPPED routes pass through unchanged (incremental rollout, nothing breaks).
const jwt = require('jsonwebtoken');
const SECRET = process.env.JWT_SECRET || 'agi-glass-secret-change-in-production';
const { resolvePerms } = require('./permissions');

// Central route -> permission map. { m:METHOD, re:path-regex, key }.
// Order = most specific first. Numeric :id matched as \d+ (disambiguates literal sub-paths).
const ROUTE_PERMS = [
  // ---------- Customers (/api/customers) ----------
  { m:'GET',    re:/^\/api\/customers\/?$/,                 key:'customers.access' },
  { m:'POST',   re:/^\/api\/customers\/?$/,                 key:'customers.create' },
  { m:'GET',    re:/^\/api\/customers\/\d+$/,               key:'customers.access' },
  { m:'PUT',    re:/^\/api\/customers\/\d+$/,               key:'customers.edit'   },
  { m:'DELETE', re:/^\/api\/customers\/\d+$/,               key:'customers.delete' },
  // ---------- Orders (/api/orders) ----------
  // lookup sub-routes (declare before /:id; non-numeric so they never collide with \d+)
  { m:'GET',    re:/^\/api\/orders\/cancel-reasons\/?$/,    key:'orders.access' },
  { m:'POST',   re:/^\/api\/orders\/cancel-reasons\/?$/,    key:'settings.cancelreasons.manage' },
  { m:'PUT',    re:/^\/api\/orders\/cancel-reasons\/\d+$/,  key:'settings.cancelreasons.manage' },
  { m:'DELETE', re:/^\/api\/orders\/cancel-reasons\/\d+$/,  key:'settings.cancelreasons.manage' },
  { m:'GET',    re:/^\/api\/orders\/type-reasons\/?$/,      key:'orders.access' },
  { m:'POST',   re:/^\/api\/orders\/type-reasons\/?$/,      key:'settings.ordertypes.manage' },
  { m:'PUT',    re:/^\/api\/orders\/type-reasons\/\d+$/,    key:'settings.ordertypes.manage' },
  { m:'DELETE', re:/^\/api\/orders\/type-reasons\/\d+$/,    key:'settings.ordertypes.manage' },
  // core order CRUD
  { m:'GET',    re:/^\/api\/orders\/?$/,                    key:'orders.access' },
  { m:'POST',   re:/^\/api\/orders\/?$/,                    key:'orders.create' },
  { m:'GET',    re:/^\/api\/orders\/\d+$/,                  key:'orders.access' },
  { m:'PUT',    re:/^\/api\/orders\/\d+$/,                  key:'orders.edit'   },
  { m:'PATCH',  re:/^\/api\/orders\/\d+\/status$/,          key:'orders.status' },
  { m:'DELETE', re:/^\/api\/orders\/\d+$/,                  key:'orders.delete' }
];

function decode(req){
  const h = req.headers['authorization'] || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : null;
  if(!t) return null;
  try { return jwt.verify(t, SECRET); } catch { return null; }
}
function matchRoute(method, path){
  for(const r of ROUTE_PERMS){ if(r.m===method && r.re.test(path)) return r; }
  return null;
}

function enforce(req, res, next){
  if(req.method === 'OPTIONS') return next();
  if(!req.path || req.path.indexOf('/api/') !== 0) return next(); // only /api/*
  const match = matchRoute(req.method, req.path);
  if(!match) return next();                       // unmapped -> current behavior
  const user = decode(req);
  if(!user) return next();                        // no/invalid token -> router's requireAuth returns 401
  req.user = req.user || user;
  let p;
  try { p = resolvePerms(user.id); }
  catch(e){ console.error('[enforce] resolve error, allowing:', e.message); return next(); } // fail-open on bug
  if(p.superadmin || p.keys.has(match.key)) return next();
  return res.status(403).json({ error:'Permission denied', need:match.key });
}

enforce.ROUTE_PERMS = ROUTE_PERMS;
enforce.matchRoute = matchRoute;
module.exports = enforce;

