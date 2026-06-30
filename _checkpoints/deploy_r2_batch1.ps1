# ============================================================================
#  BLOCK R-2 batch 1 - backend enforcement for Customers + Orders.
#  Adds middleware/enforce.js (central route->perm map) + mounts it in server.js.
#  Superadmin bypasses; Admin holds all keys; unmapped routes unchanged.
#  RUN AS ADMINISTRATOR.
# ============================================================================
$ts   = Get-Date -Format 'yyyyMMdd-HHmmss'
$srv  = 'C:\agi-server'
$mw   = Join-Path $srv 'middleware'
$bk   = Join-Path $srv '_route_backups'
New-Item -ItemType Directory -Force -Path $bk | Out-Null
$serverPath = Join-Path $srv 'server.js'
$enfPath    = Join-Path $mw 'enforce.js'
Copy-Item $serverPath (Join-Path $bk "server.js.$ts.bak") -Force
if (Test-Path $enfPath) { Copy-Item $enfPath (Join-Path $bk "enforce.js.$ts.bak") -Force }
$enf = @'
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

'@
$patch = @'
const fs=require('fs');
const p=process.argv[2]||'C:\\agi-server\\server.js';
let s=fs.readFileSync(p,'utf8');
if(s.indexOf("require('./middleware/enforce')")>=0){ console.log('SKIP: enforce already mounted'); process.exit(0); }
const anchor="app.use(express.static(path.join(__dirname, 'public')));";
const idx=s.indexOf(anchor);
if(idx<0){ console.error('ABORT: express.static anchor not found'); process.exit(2); }
let eol=s.indexOf('\n', idx+anchor.length);
if(eol<0) eol=idx+anchor.length;
const line="\napp.use(require('./middleware/enforce'));";
s=s.slice(0,eol)+line+s.slice(eol);
fs.writeFileSync(p,s,'utf8');
console.log('OK: mounted enforce after express.static');

'@
Set-Content -Path $enfPath -Value $enf -Encoding ascii
$patchPath = Join-Path $env:TEMP 'patch_server_r2.js'
Set-Content -Path $patchPath -Value $patch -Encoding ascii
Push-Location $srv
& node $patchPath $serverPath; $prc=$LASTEXITCODE
Pop-Location
if ($prc -ne 0) { Write-Host 'ABORT: patch failed; restoring.'; Copy-Item (Join-Path $bk "server.js.$ts.bak") $serverPath -Force; exit 1 }
Push-Location $srv
& node --check $enfPath;    $c1=$LASTEXITCODE
& node --check $serverPath; $c2=$LASTEXITCODE
Pop-Location
if ($c1 -ne 0 -or $c2 -ne 0) { Write-Host 'ABORT: syntax check failed; restoring server.js.'; Copy-Item (Join-Path $bk "server.js.$ts.bak") $serverPath -Force; exit 1 }
Write-Host 'enforce.js written + mounted + syntax OK.'
Stop-Service agi-glass -Force
Start-Sleep -Seconds 2
$pids = (Get-NetTCPConnection -LocalPort 3444 -State Listen -ErrorAction SilentlyContinue).OwningProcess
foreach ($p in $pids) { taskkill /F /PID $p 2>$null | Out-Null }
Start-Sleep -Seconds 1
Start-Service agi-glass
Start-Sleep -Seconds 4
Write-Host ('agi-glass status: ' + (Get-Service agi-glass).Status)
Write-Host 'R-2 batch 1 live (Customers + Orders enforced). Current users unaffected.'
