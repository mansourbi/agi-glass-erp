# ============================================================================
#  R-1 inspection (READ-ONLY) - capture exact server wiring so Roles/Privileges
#  slots in without breaking anything. Nothing is modified.
# ============================================================================
$srv = 'C:\agi-server'

Write-Host '===== middleware/auth.js (requireAuth / requireAdmin / signToken) ====='
$authPath = Join-Path $srv 'middleware\auth.js'
if (Test-Path $authPath) { Get-Content $authPath -Raw } else { Write-Host 'NOT FOUND: '+$authPath }

Write-Host ''
Write-Host '===== server.js : route registration + middleware imports ====='
Select-String -Path (Join-Path $srv 'server.js') -Pattern "app\.use\(|require\('\./routes|requireAuth|requireAdmin|express\.static|404|Not found" |
  ForEach-Object { $_.LineNumber.ToString() + ': ' + $_.Line.Trim() }

Write-Host ''
Write-Host '===== workers table columns (does role_id exist yet?) ====='
Push-Location $srv
node -e "try{const db=require('./db');console.log(db.prepare('PRAGMA table_info(workers)').all().map(c=>c.name).join(', '));}catch(e){console.log('ERR',e.message);}"
Pop-Location

Write-Host ''
Write-Host '===== existing roles seen in workers ====='
Push-Location $srv
node -e "try{const db=require('./db');console.log(db.prepare('SELECT role, COUNT(*) n FROM workers GROUP BY role').all().map(r=>r.role+':'+r.n).join('  '));}catch(e){console.log('ERR',e.message);}"
Pop-Location

Write-Host ''
Write-Host '===== routes folder (.js files) ====='
Get-ChildItem (Join-Path $srv 'routes') -Filter *.js | Select-Object -ExpandProperty Name | Sort-Object
