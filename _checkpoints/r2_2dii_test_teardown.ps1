# r2_2dii_test_teardown.ps1 -- removes batch-2d-ii verification fixtures
$ErrorActionPreference = "Stop"
$js = @'
const path = require("path");
const m = require(path.join(process.cwd(), "db"));
const db = (m && typeof m.prepare === "function") ? m : (m.db || m.default || m);
const r = db.prepare("SELECT id FROM roles WHERE name=?").get("ZZ_2DII_TEST");
const w = db.prepare("DELETE FROM workers WHERE email IN ('zz_2dii','zz_worker')").run();
if (r) {
  db.prepare("DELETE FROM role_permissions WHERE role_id=?").run(r.id);
  db.prepare("DELETE FROM roles WHERE id=?").run(r.id);
}
console.log("CLEANED: removed users("+w.changes+"), role ZZ_2DII_TEST"+(r?" (id "+r.id+")":" (absent)"));
'@
$tmp = "C:\agi-server\_zz_2dii_teardown.js"
Set-Content -Path $tmp -Value $js -Encoding ascii
Push-Location "C:\agi-server"
node $tmp
Pop-Location
Remove-Item $tmp -Force
