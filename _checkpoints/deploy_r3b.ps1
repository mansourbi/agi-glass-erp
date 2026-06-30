# deploy_r3b.ps1  -- R-3b: portal nav + settings sub-tab gating (frontend). Static-file edit, no service restart.
# Injects a guarded overlay into public/glassfab.html that hides nav sections/panes the user lacks
# permission for and redirects forbidden SP() navigation. Backend enforcement (R-2) remains the real gate.
$ErrorActionPreference = "Stop"
$ts  = Get-Date -Format "yyyyMMdd_HHmmss"
$pub = "C:\agi-server\public\glassfab.html"
$bkd = "C:\agi-server\_public_backups"
if(!(Test-Path $bkd)){ New-Item -ItemType Directory -Path $bkd | Out-Null }
$bk  = Join-Path $bkd "glassfab.html.$ts.bak"
Copy-Item $pub $bk -Force
Write-Host "Backed up glassfab.html -> $bk"

$overlay = @'
/* R3-GATING v2 (nav sections + settings sub-tabs) */
(function(){
  if (window.__R3_NAV_INSTALLED) return;
  window.__R3_NAV_INSTALLED = true;

  // ---- nav section -> permission ----
  var SECTION_PERM = {
    dash:'dashboard.view', crm:'customers.access', orders:'orders.access',
    cutting:'cutting.access', track:'tracking.access', reports:'reports.access',
    remnants:'remnants.access', deliveries:'deliveries.access', aframes:'aframes.access',
    layout:'layout.access', purchasing:'purchasing.access', pricing:'pricing.access',
    settings:'settings.access'
  };
  var NAV_ORDER = Object.keys(SECTION_PERM);

  // ---- settings sub-tab -> permission ----
  var SET_PERM = {
    rawmat:'settings.rawmaterials.view', hr:'hr.access', workers:'settings.users.manage',
    glassfam:'settings.glassfamilies.manage', remslots:'settings.remnantslots.manage',
    fpfields:'settings.fpfields.manage', finalprods:'settings.finalproducts.manage',
    procs:'settings.processes.manage', system:'settings.system.manage',
    cancelreasons:'settings.cancelreasons.manage', typereasons:'settings.ordertypes.manage',
    receivers:'settings.receivers.manage', extprocs:'settings.extprocesses.manage',
    factories:'settings.factories.manage', translations:'settings.translations.manage',
    logs:'settings.logs.view'
  };
  var SET_ORDER = Object.keys(SET_PERM);

  var superadmin = false, perms = {}, permsLoaded = false;
  function CAN(k){ return superadmin || perms[k] === true; }
  window.CAN = CAN;

  function firstNav(){ for (var i=0;i<NAV_ORDER.length;i++){ var k=NAV_ORDER[i]; if (CAN(SECTION_PERM[k])) return k; } return null; }
  function firstSet(){ for (var i=0;i<SET_ORDER.length;i++){ var k=SET_ORDER[i]; if (CAN(SET_PERM[k])) return k; } return null; }

  function applyNav(){
    for (var i=0;i<NAV_ORDER.length;i++){
      var k=NAV_ORDER[i], allowed=CAN(SECTION_PERM[k]);
      var btn=document.getElementById('nt-'+k), pg=document.getElementById('pg-'+k);
      if (btn) btn.style.display = allowed ? '' : 'none';
      if (!allowed && pg) pg.style.display = 'none';
    }
    var ab = document.querySelector('[id^="nt-"].on');
    var ak = ab ? ab.id.slice(3) : null;
    if (!ak || !CAN(SECTION_PERM[ak])) { var f=firstNav(); if (f && window.SP) window.SP(f); }
  }

  function eachSetBtn(fn){
    var els = document.querySelectorAll('[onclick]');
    for (var i=0;i<els.length;i++){
      var oc = els[i].getAttribute('onclick') || '';
      var m = oc.match(/showSettingsTab\(['"]([^'"]+)['"]\)/);
      if (m) fn(els[i], m[1]);
    }
  }
  function applySettings(){
    var activeKey = null;
    eachSetBtn(function(btn,key){
      var allowed = !(key in SET_PERM) || CAN(SET_PERM[key]);
      btn.style.display = allowed ? '' : 'none';
      var pane = document.getElementById('stab-'+key);
      if (!allowed && pane) pane.style.display='none';
      if (/(^|\s)on(\s|$)/.test(btn.className)) activeKey = key;
    });
    if (activeKey && (activeKey in SET_PERM) && !CAN(SET_PERM[activeKey])) {
      var f = firstSet(); if (f && window.showSettingsTab) window.showSettingsTab(f);
    }
  }

  function wrapSP(){
    if (window.SP && !window.SP.__r3) {
      var _SP = window.SP;
      window.SP = function(k){
        var p = SECTION_PERM[k];
        if (p && !CAN(p)) { var f=firstNav(); return f?_SP(f):undefined; }
        return _SP.apply(this, arguments);
      };
      window.SP.__r3 = true; window.SP.__orig = _SP;
    }
  }
  function wrapSet(){
    if (window.showSettingsTab && !window.showSettingsTab.__r3) {
      var _f = window.showSettingsTab;
      window.showSettingsTab = function(k){
        if ((k in SET_PERM) && !CAN(SET_PERM[k])) { var f=firstSet(); return f?_f(f):undefined; }
        return _f.apply(this, arguments);
      };
      window.showSettingsTab.__r3 = true; window.showSettingsTab.__orig = _f;
    }
  }

  function reconcile(){ if (!permsLoaded) return; wrapSP(); wrapSet(); applyNav(); applySettings(); }

  function getToken(){
    try { if (window.AGI && AGI.getToken) { var t = AGI.getToken(); if (t) return t; } } catch(e){}
    return localStorage.getItem('agi_token');
  }
  function loadPerms(){
    var tok = getToken();
    return fetch('/api/access/me', {headers:{'Authorization':'Bearer '+tok,'Accept':'application/json'}})
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(me){
        if (!me) return false;
        superadmin = !!me.superadmin; perms = {};
        (me.permissions || []).forEach(function(p){ perms[p] = true; });
        permsLoaded = true; return true;
      })
      .catch(function(){ return false; });
  }
  function start(){
    return loadPerms().then(function(ok){
      if (!ok) return;
      reconcile();
      [300,1000,3000,6000].forEach(function(d){ setTimeout(reconcile, d); });
    });
  }
  window.__R3_REAPPLY = function(){ return loadPerms().then(reconcile); };

  function ready(){ return document.getElementById('nt-dash') && typeof window.SP === 'function' && getToken(); }
  var tries = 0;
  (function boot(){ if (ready()) { start(); return; } if (tries++ < 150) setTimeout(boot, 200); })();
  window.addEventListener('load', function(){ setTimeout(function(){ if (permsLoaded) reconcile(); else start(); }, 300); });
})();
/* /R3-GATING v2 */
'@
Set-Content -Path "C:\agi-server\_r3a_overlay.js" -Value $overlay -Encoding ascii

$patch = @'
const fs = require('fs');
const file = 'C:\\agi-server\\public\\glassfab.html';
const ovl  = 'C:\\agi-server\\_r3a_overlay.js';
const START = '<!-- R3-NAV-GATING v1 START -->';
const END   = '<!-- R3-NAV-GATING v1 END -->';

const overlay = fs.readFileSync(ovl, 'utf8');
// syntax-check overlay without executing (window/document not needed to parse)
try { new Function(overlay); } catch (e) { console.log('OVERLAY SYNTAX ERROR: ' + e.message); process.exit(2); }

let html = fs.readFileSync(file, 'utf8');
// idempotent: strip any previous block between markers
const s = html.indexOf(START), e = html.indexOf(END);
if (s !== -1 && e !== -1) { html = html.slice(0, s) + html.slice(e + END.length); }

const block = '\n' + START + '\n<script>\n' + overlay + '\n</script>\n' + END + '\n';
const idx = html.lastIndexOf('</body>');
if (idx === -1) { console.log('ERROR: no </body> in glassfab.html'); process.exit(1); }
html = html.slice(0, idx) + block + html.slice(idx);
fs.writeFileSync(file, html, 'utf8');
console.log('R3a injected. START present: ' + (html.indexOf(START) !== -1) + ' | END present: ' + (html.indexOf(END) !== -1) + ' | overlay bytes: ' + overlay.length);
'@
Set-Content -Path "C:\agi-server\_r3a_patch.js" -Value $patch -Encoding ascii

Push-Location "C:\agi-server"
node _r3a_patch.js
$rc = $LASTEXITCODE
Pop-Location
if($rc -ne 0){ Write-Host "PATCH FAILED ($rc) -> restoring backup"; Copy-Item $bk $pub -Force; Remove-Item "C:\agi-server\_r3a_overlay.js","C:\agi-server\_r3a_patch.js" -EA SilentlyContinue; exit 1 }

# verify markers present in the live file
$html = Get-Content $pub -Raw
$ok = $html.Contains("<!-- R3-NAV-GATING v1 START -->") -and $html.Contains("<!-- R3-NAV-GATING v1 END -->")
Write-Host ("markers present: " + $ok)
if(-not $ok){ Write-Host "MARKER CHECK FAIL -> restoring backup"; Copy-Item $bk $pub -Force; Remove-Item "C:\agi-server\_r3a_overlay.js","C:\agi-server\_r3a_patch.js" -EA SilentlyContinue; exit 1 }

# cleanup temp files
Remove-Item "C:\agi-server\_r3a_overlay.js","C:\agi-server\_r3a_patch.js" -EA SilentlyContinue
Write-Host "R3b deployed (nav + settings sub-tab gating). Reload the portal (Ctrl+F5) to see it -- static file, no service restart needed."
