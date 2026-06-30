# deploy_r2_batch2a.ps1  -- R-2 batch 2a: Cutting / Remnants / A-Frames / Layout + customers-list worker fix
# Replaces middleware/enforce.js only (already mounted in server.js). Backup + node --check + robust restart.
$ErrorActionPreference = "Stop"
$ts  = Get-Date -Format "yyyyMMdd_HHmmss"
$dst = "C:\agi-server\middleware\enforce.js"
$bkd = "C:\agi-server\_route_backups"
if(!(Test-Path $bkd)){ New-Item -ItemType Directory -Path $bkd | Out-Null }
$bk  = Join-Path $bkd "enforce.js.$ts.bak"
Copy-Item $dst $bk -Force
Write-Host "Backed up current enforce.js -> $bk"

$code = @'
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
  { m:'GET',    re:/^\/api\/customers\/?$/,                 anyOf:['customers.access','workerapp.access'] },
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
  // GET reads are needed by portal staff (orders.access) AND the worker app (workerapp.access)
  { m:'GET',    re:/^\/api\/orders\/?$/,                    anyOf:['orders.access','workerapp.access'] },
  { m:'POST',   re:/^\/api\/orders\/?$/,                    key:'orders.create' },
  { m:'GET',    re:/^\/api\/orders\/\d+$/,                  anyOf:['orders.access','workerapp.access'] },
  { m:'PUT',    re:/^\/api\/orders\/\d+$/,                  key:'orders.edit'   },
  { m:'PATCH',  re:/^\/api\/orders\/\d+\/status$/,          key:'orders.status' },
  { m:'DELETE', re:/^\/api\/orders\/\d+$/,                  key:'orders.delete' },

  // ---------- Cutting: queue/movements (cutting.js) ----------
  { m:'GET',    re:/^\/api\/cutting\/movements\/?$/,        key:'cutting.access' },
  { m:'POST',   re:/^\/api\/cutting\/movements\/?$/,        key:'cutting.edit'   },
  { m:'DELETE', re:/^\/api\/cutting\/movements\/\d+$/,      key:'cutting.edit'   },
  { m:'GET',    re:/^\/api\/cutting\/opt\/\d+\/progress$/,  key:'cutting.access' },
  { m:'GET',    re:/^\/api\/cutting\/daily\/?$/,            key:'cutting.access' },
  { m:'GET',    re:/^\/api\/cutting\/progress\/?$/,         key:'cutting.access' },
  // ---------- Cutting: optimization files (optfiles.js) ----------
  { m:'GET',    re:/^\/api\/optfiles\/?$/,                  key:'cutting.access' },
  { m:'GET',    re:/^\/api\/optfiles\/\d+$/,                key:'cutting.access' },
  { m:'POST',   re:/^\/api\/optfiles\/?$/,                  key:'cutting.create' },
  { m:'PUT',    re:/^\/api\/optfiles\/\d+$/,                key:'cutting.edit'   },
  { m:'DELETE', re:/^\/api\/optfiles\/\d+$/,                key:'cutting.edit'   },
  // ---------- Remnants (remnants.js) ----------
  { m:'GET',    re:/^\/api\/remnants\/slots\/?$/,           key:'remnants.access' },
  { m:'POST',   re:/^\/api\/remnants\/slots\/?$/,           key:'remnants.edit'   },
  { m:'PUT',    re:/^\/api\/remnants\/slots\/\d+$/,         key:'remnants.edit'   },
  { m:'DELETE', re:/^\/api\/remnants\/slots\/\d+$/,         key:'remnants.edit'   },
  { m:'GET',    re:/^\/api\/remnants\/fit\/?$/,             key:'remnants.access' },
  { m:'GET',    re:/^\/api\/remnants\/stats\/?$/,           key:'remnants.access' },
  { m:'GET',    re:/^\/api\/remnants\/log\/workers\/?$/,    key:'remnants.access' },
  { m:'GET',    re:/^\/api\/remnants\/log\/?$/,             key:'remnants.access' },
  { m:'GET',    re:/^\/api\/remnants\/\d+\/log$/,           key:'remnants.access' },
  { m:'GET',    re:/^\/api\/remnants\/?$/,                  key:'remnants.access' },
  { m:'POST',   re:/^\/api\/remnants\/?$/,                  key:'remnants.create' },
  { m:'POST',   re:/^\/api\/remnants\/\d+\/use$/,           key:'remnants.assign' },
  { m:'PUT',    re:/^\/api\/remnants\/\d+$/,                key:'remnants.edit'   },
  { m:'DELETE', re:/^\/api\/remnants\/\d+$/,                key:'remnants.delete' },
  // ---------- A-Frames (slots.js) ----------
  { m:'GET',    re:/^\/api\/slots\/all-inventory\/?$/,      key:'aframes.access' },
  { m:'GET',    re:/^\/api\/slots\/movements\/?$/,          key:'aframes.access' },
  { m:'PUT',    re:/^\/api\/slots\/inventory\/\d+$/,        key:'aframes.stock.edit' },
  { m:'DELETE', re:/^\/api\/slots\/inventory\/\d+$/,        key:'aframes.stock.edit' },
  { m:'POST',   re:/^\/api\/slots\/deduct\/?$/,             key:'aframes.stock.edit' },
  { m:'GET',    re:/^\/api\/slots\/\d+\/inventory$/,        key:'aframes.access' },
  { m:'POST',   re:/^\/api\/slots\/\d+\/assign$/,           key:'aframes.stock.assign' },
  { m:'GET',    re:/^\/api\/slots\/?$/,                     key:'aframes.access' },
  { m:'POST',   re:/^\/api\/slots\/?$/,                     key:'aframes.slots.edit' },
  { m:'PUT',    re:/^\/api\/slots\/\d+$/,                   key:'aframes.slots.edit' },
  { m:'DELETE', re:/^\/api\/slots\/\d+$/,                   key:'aframes.slots.edit' },
  // ---------- Layout (layout.js) ----------
  { m:'GET',    re:/^\/api\/layout\/?$/,                    key:'layout.access' },
  { m:'PUT',    re:/^\/api\/layout\/?$/,                    key:'layout.edit'   }
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
  if(p.superadmin) return next();
  const ok = match.anyOf ? match.anyOf.some(function(k){ return p.keys.has(k); }) : p.keys.has(match.key);
  if(ok) return next();
  return res.status(403).json({ error:'Permission denied', need: match.anyOf ? match.anyOf.join(' OR ') : match.key });
}

enforce.ROUTE_PERMS = ROUTE_PERMS;
enforce.matchRoute = matchRoute;
module.exports = enforce;
'@
Set-Content -Path $dst -Value $code -Encoding ascii
Write-Host "Wrote enforce.js"

Push-Location C:\agi-server
node --check middleware\enforce.js
if ($LASTEXITCODE -ne 0) { Write-Host "SYNTAX FAIL -> restoring backup"; Copy-Item $bk $dst -Force; Pop-Location; exit 1 }
Pop-Location
Write-Host "node --check OK"

# round-trip marker verify (confirms the new content actually landed)
$txt = Get-Content $dst -Raw
$ok = ($txt -match "aframes\.stock\.assign") -and ($txt -match "remnants\.delete") -and ($txt -match "layout\.edit") -and ($txt -match "cutting\.create")
Write-Host ("batch-2a markers present: " + $ok)
if(-not $ok){ Write-Host "MARKER CHECK FAIL -> restoring backup"; Copy-Item $bk $dst -Force; exit 1 }

# robust restart
Stop-Service agi-glass -Force
Start-Sleep 2
$pids=(Get-NetTCPConnection -LocalPort 3444 -State Listen -EA SilentlyContinue).OwningProcess
foreach($p in $pids){ taskkill /F /PID $p 2>$null | Out-Null }
Start-Sleep 1
Start-Service agi-glass
Start-Sleep 2
Write-Host ("agi-glass status: " + (Get-Service agi-glass).Status)
Write-Host "Batch 2a deployed (Cutting / Remnants / A-Frames / Layout + customers-list worker fix)."
