# r2_2c_test_setup.ps1 -- creates batch-2c verification fixtures (portal-only)
#  * role ZZ_2C_TEST (portal) perms: reports.productivity, orders.pricing.view,
#                                    pricing.profiles.view, purchasing.access
#  * user zz_2c/zz2c123 (role string 'admin' bypasses device; role_id drives enforce)
$ErrorActionPreference = "Stop"
$js = @'
const path = require("path");
const bcrypt = require("bcryptjs");
const m = require(path.join(process.cwd(), "db"));
const db = (m && typeof m.prepare === "function") ? m : (m.db || m.default || m);

function roleId(name){ const r = db.prepare("SELECT id FROM roles WHERE name=?").get(name); return r && r.id; }

db.prepare("INSERT OR IGNORE INTO roles(name,description,is_system,superadmin,portal_access,workerapp_access) VALUES(?,?,0,0,1,0)")
  .run("ZZ_2C_TEST","batch-2c verification role");
const rid = roleId("ZZ_2C_TEST");
db.prepare("DELETE FROM role_permissions WHERE role_id=?").run(rid);
const ins = db.prepare("INSERT OR IGNORE INTO role_permissions(role_id,perm_key) VALUES(?,?)");
["reports.productivity","orders.pricing.view","pricing.profiles.view","purchasing.access"].forEach(k => ins.run(rid, k));

const ph = bcrypt.hashSync("zz2c123", 10);
db.prepare("DELETE FROM workers WHERE email=?").run("zz_2c");
db.prepare("INSERT INTO workers(name,email,pass_hash,role,processes,is_active,role_id) VALUES(?,?,?,?,?,1,?)")
  .run("ZZ 2C Test","zz_2c",ph,"admin","[]",rid);

console.log("READY: zz_2c/zz2c123 (role ZZ_2C_TEST id "+rid+", perms reports.productivity+orders.pricing.view+pricing.profiles.view+purchasing.access)");
'@
$tmp = "C:\agi-server\_zz_2c_setup.js"
Set-Content -Path $tmp -Value $js -Encoding ascii
Push-Location "C:\agi-server"
node $tmp
Pop-Location
Remove-Item $tmp -Force
