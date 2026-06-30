# r3a_test_setup.ps1 -- restricted portal role to verify nav gating end-to-end
#  * role ZZ_R3C_TEST (portal) perms: portal.access, orders.access, cutting.access, tracking.access
#  * user zz_r3c/zzr3c123 (role string 'admin' bypasses device; role_id drives enforce + /api/access/me)
$ErrorActionPreference = "Stop"
$js = @'
const path = require("path");
const bcrypt = require("bcryptjs");
const m = require(path.join(process.cwd(), "db"));
const db = (m && typeof m.prepare === "function") ? m : (m.db || m.default || m);
function roleId(name){ const r = db.prepare("SELECT id FROM roles WHERE name=?").get(name); return r && r.id; }
db.prepare("INSERT OR IGNORE INTO roles(name,description,is_system,superadmin,portal_access,workerapp_access) VALUES(?,?,0,0,1,0)")
  .run("ZZ_R3C_TEST","R-3c button-gating verification role");
const rid = roleId("ZZ_R3C_TEST");
db.prepare("DELETE FROM role_permissions WHERE role_id=?").run(rid);
const ins = db.prepare("INSERT OR IGNORE INTO role_permissions(role_id,perm_key) VALUES(?,?)");
["portal.access","orders.access","orders.create","customers.access","reports.access","cutting.access"].forEach(k => ins.run(rid, k));
const ph = bcrypt.hashSync("zzr3c123", 10);
db.prepare("DELETE FROM workers WHERE email=?").run("zz_r3c");
db.prepare("INSERT INTO workers(name,email,pass_hash,role,processes,is_active,role_id) VALUES(?,?,?,?,?,1,?)")
  .run("ZZ R3C Test","zz_r3c",ph,"admin","[]",rid);
console.log("READY: zz_r3c/zzr3c123 (role ZZ_R3C_TEST id "+rid+", perms orders(+create)+customers+reports+cutting, no customers.create/exports)");
'@
$tmp = "C:\agi-server\_zz_r3c_setup.js"
Set-Content -Path $tmp -Value $js -Encoding ascii
Push-Location "C:\agi-server"
node $tmp
Pop-Location
Remove-Item $tmp -Force
