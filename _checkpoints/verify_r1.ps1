# READ-ONLY: confirm R-1 seed + user->role mapping before R-2 enforcement.
$srv = 'C:\agi-server'
$js  = Join-Path $env:TEMP 'verify_r1.js'
$code = @'
const path=require("path");
const db=require(path.join(process.cwd(),"db"));   // resolve db relative to cwd (C:\agi-server), not the temp file
const roles=db.prepare("SELECT id,name,superadmin,portal_access,workerapp_access FROM roles ORDER BY id").all();
console.log("ROLES:");
roles.forEach(r=>console.log("  "+r.id+": "+r.name+(r.superadmin?" [SUPERADMIN]":"")+"  portal="+r.portal_access+" app="+r.workerapp_access));
const split=db.prepare("SELECT COALESCE(r.name,'(unassigned)') nm, COUNT(*) n FROM workers w LEFT JOIN roles r ON r.id=w.role_id GROUP BY w.role_id ORDER BY nm").all();
console.log("USER -> ROLE:");
split.forEach(s=>console.log("  "+s.nm+": "+s.n));
const keys=db.prepare("SELECT r.name nm, COUNT(*) c FROM role_permissions rp JOIN roles r ON r.id=rp.role_id GROUP BY rp.role_id ORDER BY nm").all();
console.log("ROLE KEY COUNTS:");
keys.forEach(k=>console.log("  "+k.nm+": "+k.c));
console.log("workers without a role:", db.prepare("SELECT COUNT(*) c FROM workers WHERE role_id IS NULL").get().c);
'@
Set-Content -Path $js -Value $code -Encoding ascii
Push-Location $srv
node $js
Pop-Location
Remove-Item $js -Force
