# deploy_r2_batch2di.ps1  -- R-2 batch 2d-i: Settings master-data mutations (portal-only)
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
  { m:'PUT',    re:/^\/api\/layout\/?$/,                    key:'layout.edit'   },

  // ---------- Deliveries (deliveries.js) -- worker Deliver tab drives this ----------
  // receivers (mutations are settings; GET read shared with worker finalise dropdown)
  { m:'GET',    re:/^\/api\/deliveries\/receivers\/?$/,      anyOf:['deliveries.access','workerapp.deliver'] },
  { m:'POST',   re:/^\/api\/deliveries\/receivers\/?$/,      key:'settings.receivers.manage' },
  { m:'PUT',    re:/^\/api\/deliveries\/receivers\/\d+$/,    key:'settings.receivers.manage' },
  { m:'DELETE', re:/^\/api\/deliveries\/receivers\/\d+$/,    key:'settings.receivers.manage' },
  // portal-only piece views
  { m:'GET',    re:/^\/api\/deliveries\/pieces-status\/?$/,  key:'deliveries.access' },
  { m:'GET',    re:/^\/api\/deliveries\/by-piece\/[^/]+$/,   key:'deliveries.access' },
  // reads shared with worker
  { m:'GET',    re:/^\/api\/deliveries\/?$/,                 anyOf:['deliveries.access','workerapp.deliver'] },
  { m:'GET',    re:/^\/api\/deliveries\/\d+$/,               anyOf:['deliveries.access','workerapp.deliver'] },
  // worker delivery workflow (these routes have NO inline requireAdmin)
  { m:'POST',   re:/^\/api\/deliveries\/?$/,                 anyOf:['deliveries.create','workerapp.deliver'] },
  { m:'POST',   re:/^\/api\/deliveries\/\d+\/items\/?$/,     anyOf:['deliveries.edit','workerapp.deliver'] },
  { m:'DELETE', re:/^\/api\/deliveries\/\d+\/items\/[^/]+$/, anyOf:['deliveries.edit','workerapp.deliver'] },
  { m:'POST',   re:/^\/api\/deliveries\/\d+\/finalise\/?$/,  anyOf:['deliveries.finalize','workerapp.deliver'] },
  // admin-backstopped (inline requireAdmin already blocks workers)
  { m:'PATCH',  re:/^\/api\/deliveries\/\d+\/factory\/?$/,   key:'deliveries.edit'   },
  { m:'DELETE', re:/^\/api\/deliveries\/\d+$/,               key:'deliveries.delete' },

  // ---------- Labels / Tracking (labels.js) -- worker scan core ----------
  // literal sub-paths MUST precede the /:uid catch-all (uid is non-numeric -> [^/]+)
  { m:'GET',    re:/^\/api\/labels\/scan\/history$/,         anyOf:['workerapp.access','tracking.access'] },
  { m:'GET',    re:/^\/api\/labels\/scanlog\/?$/,            anyOf:['workerapp.access','tracking.access'] },
  { m:'GET',    re:/^\/api\/labels\/pending\/?$/,            anyOf:['workerapp.access','tracking.access','cutting.access'] },
  { m:'POST',   re:/^\/api\/labels\/scan\/?$/,               anyOf:['workerapp.access','tracking.update'] },
  { m:'GET',    re:/^\/api\/labels\/?$/,                     anyOf:['tracking.access','cutting.access','workerapp.access'] },
  { m:'POST',   re:/^\/api\/labels\/?$/,                     key:'cutting.labels' },
  { m:'DELETE', re:/^\/api\/labels\/[^/]+\/process\/\d+$/,   anyOf:['workerapp.access','tracking.update'] },
  { m:'GET',    re:/^\/api\/labels\/[^/]+$/,                 anyOf:['workerapp.access','tracking.access','cutting.access'] },

  // ---------- Tracking report (reports.js -- only the per-order tracking view here) ----------
  { m:'GET',    re:/^\/api\/reports\/tracking\/\d+$/,        key:'tracking.access' },

  // ============ BATCH 2c: Reports / Pricing / Purchasing (portal-only) ============
  // ---------- Reports (reports.js) -- /tracking already mapped above ----------
  { m:'GET',    re:/^\/api\/reports\/productivity-v2\/?$/,   key:'reports.productivity' },
  { m:'GET',    re:/^\/api\/reports\/productivity-raw\/?$/,  anyOf:['reports.productivity','reports.export'] },
  { m:'GET',    re:/^\/api\/reports\/productivity\/?$/,      key:'reports.productivity' },
  { m:'GET',    re:/^\/api\/reports\/workers\/?$/,           key:'reports.workers' },
  { m:'GET',    re:/^\/api\/reports\/orders\/?$/,            key:'reports.orders' },

  // ---------- Order pricing: legacy (orderpricing.js) ----------
  { m:'GET',    re:/^\/api\/orderpricing\/\d+$/,             key:'orders.pricing.view' },
  { m:'POST',   re:/^\/api\/orderpricing\/\d+$/,             key:'orders.pricing.edit' },

  // ---------- Order pricing: engine (pricing2.js) ----------
  { m:'GET',    re:/^\/api\/pricing2\/\d+\/preview$/,        key:'orders.pricing.view' },
  { m:'GET',    re:/^\/api\/pricing2\/\d+\/choice$/,         key:'orders.pricing.view' },
  { m:'PUT',    re:/^\/api\/pricing2\/\d+\/choice$/,         key:'orders.pricing.edit' },
  { m:'GET',    re:/^\/api\/pricing2\/\d+\/charges$/,        key:'orders.pricing.view' },
  { m:'POST',   re:/^\/api\/pricing2\/\d+\/charges$/,        key:'orders.pricing.edit' },
  { m:'DELETE', re:/^\/api\/pricing2\/\d+\/charges\/\d+$/,   key:'orders.pricing.edit' },
  { m:'GET',    re:/^\/api\/pricing2\/\d+\/snapshot$/,       key:'orders.pricing.view' },
  { m:'POST',   re:/^\/api\/pricing2\/\d+\/finalize$/,       key:'orders.pricing.finalize' },
  { m:'DELETE', re:/^\/api\/pricing2\/\d+\/finalize$/,       key:'orders.pricing.finalize' },

  // ---------- Pricing catalog admin (pricing_admin.js) ----------
  { m:'GET',    re:/^\/api\/pricing_admin\/meta\/?$/,                       key:'pricing.access' },
  { m:'GET',    re:/^\/api\/pricing_admin\/profiles\/?$/,                   key:'pricing.profiles.view' },
  { m:'GET',    re:/^\/api\/pricing_admin\/profiles\/\d+$/,                 key:'pricing.profiles.view' },
  { m:'POST',   re:/^\/api\/pricing_admin\/profiles\/?$/,                   key:'pricing.profiles.edit' },
  { m:'PUT',    re:/^\/api\/pricing_admin\/profiles\/\d+$/,                 key:'pricing.profiles.edit' },
  { m:'DELETE', re:/^\/api\/pricing_admin\/profiles\/\d+$/,                 key:'pricing.profiles.edit' },
  { m:'POST',   re:/^\/api\/pricing_admin\/profiles\/\d+\/rules$/,          key:'pricing.profiles.edit' },
  { m:'PUT',    re:/^\/api\/pricing_admin\/rules\/\d+$/,                    key:'pricing.profiles.edit' },
  { m:'DELETE', re:/^\/api\/pricing_admin\/rules\/\d+$/,                    key:'pricing.profiles.edit' },
  { m:'GET',    re:/^\/api\/pricing_admin\/categories\/?$/,                 key:'pricing.categories.view' },
  { m:'POST',   re:/^\/api\/pricing_admin\/categories\/?$/,                 key:'pricing.categories.edit' },
  { m:'PUT',    re:/^\/api\/pricing_admin\/categories\/\d+$/,               key:'pricing.categories.edit' },
  { m:'DELETE', re:/^\/api\/pricing_admin\/categories\/\d+$/,               key:'pricing.categories.edit' },
  { m:'GET',    re:/^\/api\/pricing_admin\/products\/?$/,                   key:'pricing.products.view' },
  { m:'PUT',    re:/^\/api\/pricing_admin\/products\/\d+\/default$/,        key:'pricing.products.edit' },
  { m:'GET',    re:/^\/api\/pricing_admin\/customers\/\d+\/prices$/,        key:'customers.pricelist.view' },
  { m:'POST',   re:/^\/api\/pricing_admin\/customers\/\d+\/prices$/,        key:'customers.pricelist.edit' },
  { m:'DELETE', re:/^\/api\/pricing_admin\/customers\/\d+\/prices\/[^/]+$/, key:'customers.pricelist.edit' },

  // ---------- Purchases: legacy simple (purchases.js) ----------
  { m:'GET',    re:/^\/api\/purchases\/?$/,                  key:'purchasing.access' },
  { m:'POST',   re:/^\/api\/purchases\/?$/,                  key:'purchasing.create' },
  { m:'DELETE', re:/^\/api\/purchases\/\d+$/,                key:'purchasing.delete' },

  // ---------- Purchasing: full PO/inventory (purchasing.js) ----------
  // PO categories
  { m:'GET',    re:/^\/api\/purchasing\/categories\/?$/,        key:'purchasing.access' },
  { m:'POST',   re:/^\/api\/purchasing\/categories\/?$/,        key:'purchasing.edit' },
  { m:'PUT',    re:/^\/api\/purchasing\/categories\/\d+$/,      key:'purchasing.edit' },
  // suppliers/vendors (reads shared with Settings->Vendors)
  { m:'GET',    re:/^\/api\/purchasing\/suppliers\/?$/,         anyOf:['purchasing.access','settings.vendors.manage'] },
  { m:'GET',    re:/^\/api\/purchasing\/suppliers\/\d+$/,       anyOf:['purchasing.access','settings.vendors.manage'] },
  { m:'POST',   re:/^\/api\/purchasing\/suppliers\/?$/,         key:'settings.vendors.manage' },
  { m:'PUT',    re:/^\/api\/purchasing\/suppliers\/\d+$/,       key:'settings.vendors.manage' },
  { m:'DELETE', re:/^\/api\/purchasing\/suppliers\/\d+$/,       key:'settings.vendors.manage' },
  // manufacturers (reads shared with Settings->Manufacturers)
  { m:'GET',    re:/^\/api\/purchasing\/manufacturers\/?$/,     anyOf:['purchasing.access','settings.manufacturers.manage'] },
  { m:'GET',    re:/^\/api\/purchasing\/manufacturers\/\d+$/,   anyOf:['purchasing.access','settings.manufacturers.manage'] },
  { m:'POST',   re:/^\/api\/purchasing\/manufacturers\/?$/,     key:'settings.manufacturers.manage' },
  { m:'PUT',    re:/^\/api\/purchasing\/manufacturers\/\d+$/,   key:'settings.manufacturers.manage' },
  { m:'DELETE', re:/^\/api\/purchasing\/manufacturers\/\d+$/,   key:'settings.manufacturers.manage' },
  // PO line items / costs (specific :param paths)
  { m:'POST',   re:/^\/api\/purchasing\/\d+\/items$/,          key:'purchasing.edit' },
  { m:'PUT',    re:/^\/api\/purchasing\/items\/\d+$/,          key:'purchasing.edit' },
  { m:'DELETE', re:/^\/api\/purchasing\/items\/\d+$/,          key:'purchasing.edit' },
  { m:'POST',   re:/^\/api\/purchasing\/\d+\/costs$/,          key:'purchasing.edit' },
  { m:'PUT',    re:/^\/api\/purchasing\/costs\/\d+$/,          key:'purchasing.edit' },
  { m:'DELETE', re:/^\/api\/purchasing\/costs\/\d+$/,          key:'purchasing.edit' },
  // receive + inventory ops
  { m:'POST',   re:/^\/api\/purchasing\/\d+\/receive$/,        key:'purchasing.receive' },
  { m:'POST',   re:/^\/api\/purchasing\/batches\/[^/]+\/adjust$/, key:'purchasing.edit' },
  { m:'POST',   re:/^\/api\/purchasing\/opening-wac\/?$/,      key:'purchasing.edit' },
  { m:'GET',    re:/^\/api\/purchasing\/cost-history\/[^/]+$/, key:'purchasing.access' },
  { m:'GET',    re:/^\/api\/purchasing\/reports\/supplier-spend\/?$/,  key:'purchasing.access' },
  { m:'GET',    re:/^\/api\/purchasing\/reports\/inventory-value\/?$/, key:'purchasing.access' },
  // PO core (catch-alls LAST; :id is numeric so literal segments above never collide)
  { m:'GET',    re:/^\/api\/purchasing\/\d+\/preview$/,        key:'purchasing.access' },
  { m:'GET',    re:/^\/api\/purchasing\/?$/,                   key:'purchasing.access' },
  { m:'GET',    re:/^\/api\/purchasing\/\d+$/,                 key:'purchasing.access' },
  { m:'POST',   re:/^\/api\/purchasing\/?$/,                   key:'purchasing.create' },
  { m:'PATCH',  re:/^\/api\/purchasing\/\d+\/arrived$/,        key:'purchasing.edit' },
  { m:'PUT',    re:/^\/api\/purchasing\/\d+$/,                 key:'purchasing.edit' },
  { m:'DELETE', re:/^\/api\/purchasing\/\d+$/,                 key:'purchasing.delete' },

  // ============ BATCH 2d-i: Settings master-data MUTATIONS (reference reads stay unmapped) ============
  // ---- config (server.js inline) ----
  { m:'PUT',    re:/^\/api\/config\/?$/,                        key:'settings.system.manage' },
  // ---- purchasing PO supplier change (server.js inline; closes requireAuth-only hole) ----
  { m:'PATCH',  re:/^\/api\/purchasing\/\d+\/supplier$/,        key:'purchasing.edit' },
  // ---- raw sheets (rawsheets.js) ----
  { m:'POST',   re:/^\/api\/rawsheets\/?$/,                     key:'settings.rawmaterials.edit' },
  { m:'PUT',    re:/^\/api\/rawsheets\/\d+$/,                   key:'settings.rawmaterials.edit' },
  { m:'DELETE', re:/^\/api\/rawsheets\/\d+$/,                   key:'settings.rawmaterials.edit' },
  { m:'POST',   re:/^\/api\/rawsheets\/\d+\/transactions$/,     key:'settings.rawmaterials.edit' },
  { m:'PUT',    re:/^\/api\/rawsheets\/transactions\/\d+$/,     key:'settings.rawmaterials.edit' },
  { m:'DELETE', re:/^\/api\/rawsheets\/transactions\/\d+$/,     key:'settings.rawmaterials.edit' },
  { m:'POST',   re:/^\/api\/rawsheets\/record-optimization\/?$/, anyOf:['cutting.optimize','cutting.create','settings.rawmaterials.edit'] },
  // ---- glass families ----
  { m:'POST',   re:/^\/api\/glassfamilies\/reseed$/,            key:'settings.glassfamilies.manage' },
  { m:'POST',   re:/^\/api\/glassfamilies\/?$/,                 key:'settings.glassfamilies.manage' },
  { m:'PUT',    re:/^\/api\/glassfamilies\/\d+$/,               key:'settings.glassfamilies.manage' },
  { m:'DELETE', re:/^\/api\/glassfamilies\/\d+$/,               key:'settings.glassfamilies.manage' },
  // ---- final products ----
  { m:'POST',   re:/^\/api\/finalproducts\/?$/,                 key:'settings.finalproducts.manage' },
  { m:'PUT',    re:/^\/api\/finalproducts\/\d+$/,               key:'settings.finalproducts.manage' },
  { m:'DELETE', re:/^\/api\/finalproducts\/\d+$/,               key:'settings.finalproducts.manage' },
  // ---- fp fields ----
  { m:'POST',   re:/^\/api\/fpfields\/?$/,                      key:'settings.fpfields.manage' },
  { m:'PUT',    re:/^\/api\/fpfields\/\d+$/,                    key:'settings.fpfields.manage' },
  { m:'DELETE', re:/^\/api\/fpfields\/\d+$/,                    key:'settings.fpfields.manage' },
  // ---- external processes ----
  { m:'POST',   re:/^\/api\/extprocesses\/?$/,                  key:'settings.extprocesses.manage' },
  { m:'PUT',    re:/^\/api\/extprocesses\/\d+$/,                key:'settings.extprocesses.manage' },
  { m:'DELETE', re:/^\/api\/extprocesses\/\d+$/,                key:'settings.extprocesses.manage' },
  // ---- sheet owner ----
  { m:'POST',   re:/^\/api\/sheetowner\/bulk\/set$/,            key:'settings.rawmaterials.edit' },
  { m:'POST',   re:/^\/api\/sheetowner\/\d+$/,                  key:'settings.rawmaterials.edit' },
  // ---- factories (reads stay unmapped: reference for deliveries/worker finalise) ----
  { m:'POST',   re:/^\/api\/factories\/?$/,                     key:'settings.factories.manage' },
  { m:'PUT',    re:/^\/api\/factories\/\d+$/,                   key:'settings.factories.manage' },
  { m:'DELETE', re:/^\/api\/factories\/\d+$/,                   key:'settings.factories.manage' },
  // ---- translations (bare GET + /list stay readable/unmapped; key is non-numeric) ----
  { m:'POST',   re:/^\/api\/translations\/?$/,                  key:'settings.translations.manage' },
  { m:'PUT',    re:/^\/api\/translations\/[^/]+$/,              key:'settings.translations.manage' },
  { m:'DELETE', re:/^\/api\/translations\/[^/]+$/,              key:'settings.translations.manage' },
  // ---- gsheets admin viewer (sync endpoints stay unmapped for cron auth) ----
  { m:'PATCH',  re:/^\/api\/gsheets\/viewers\/\d+$/,            key:'settings.system.manage' },
  // ---- customer prices (reads unmapped for order-entry safety; mutations gated) ----
  { m:'POST',   re:/^\/api\/customerprices\/?$/,                key:'customers.pricelist.edit' },
  { m:'DELETE', re:/^\/api\/customerprices\/\d+$/,              key:'customers.pricelist.edit' },
  { m:'DELETE', re:/^\/api\/customerprices\/?$/,                key:'customers.pricelist.edit' }
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
$ok = ($txt -match "settings\.glassfamilies\.manage") -and ($txt -match "settings\.rawmaterials\.edit") -and ($txt -match "settings\.factories\.manage")
Write-Host ("batch-2d-i markers present: " + $ok)
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
Write-Host "Batch 2d-i deployed (Settings master-data mutations (portal-only))."
