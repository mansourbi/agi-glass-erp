# r2_2di_test_setup.ps1 -- creates batch-2d-i verification fixtures (portal-only)
#  * role ZZ_2DI_TEST (portal) perms: settings.glassfamilies.manage, settings.rawmaterials.edit
#  * user zz_2di/zz2di123 (role string 'admin' bypasses device; role_id drives enforce)
$ErrorActionPreference = "Stop"
$js = @'
const path = require("path");
const bcrypt = require("bcryptjs");
const m = require(path.join(process.cwd(), "db"));
const db = (m && typeof m.prepare === "function") ? m : (m.db || m.default || m);
function roleId(name){ const r = db.prepare("SELECT id FROM roles WHERE name=?").get(name); return r && r.id; }
db.prepare("INSERT OR IGNORE INTO roles(name,description,is_system,superadmin,portal_access,workerapp_access) VALUES(?,?,0,0,1,0)")
  .run("ZZ_2DI_TEST","batch-2d-i verification role");
const rid = roleId("ZZ_2DI_TEST");
db.prepare("DELETE FROM role_permissions WHERE role_id=?").run(rid);
const ins = db.prepare("INSERT OR IGNORE INTO role_permissions(role_id,perm_key) VALUES(?,?)");
["settings.glassfamilies.manage","settings.rawmaterials.edit"].forEach(k => ins.run(rid, k));
const ph = bcrypt.hashSync("zz2di123", 10);
db.prepare("DELETE FROM workers WHERE email=?").run("zz_2di");
db.prepare("INSERT INTO workers(name,email,pass_hash,role,processes,is_active,role_id) VALUES(?,?,?,?,?,1,?)")
  .run("ZZ 2DI Test","zz_2di",ph,"admin","[]",rid);
console.log("READY: zz_2di/zz2di123 (role ZZ_2DI_TEST id "+rid+", perms settings.glassfamilies.manage+settings.rawmaterials.edit)");
'@
$tmp = "C:\agi-server\_zz_2di_setup.js"
Set-Content -Path $tmp -Value $js -Encoding ascii
Push-Location "C:\agi-server"
node $tmp
Pop-Location
Remove-Item $tmp -Force
