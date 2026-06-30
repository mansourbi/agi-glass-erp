# Removes the temporary enforcement-test role + user.
$srv = 'C:\agi-server'
$js  = Join-Path $srv '_tmp_r2_teardown.js'
$code = @'
const db=require("./db");
db.prepare("DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE name='ZZ_TEST_LIMITED')").run();
const w=db.prepare("DELETE FROM workers WHERE email='zz_test'").run();
const r=db.prepare("DELETE FROM roles WHERE name='ZZ_TEST_LIMITED'").run();
console.log("CLEANED: removed test user ("+w.changes+") and role ("+r.changes+")");
'@
Set-Content -Path $js -Value $code -Encoding ascii
Push-Location $srv; node $js; Pop-Location
Remove-Item $js -Force
