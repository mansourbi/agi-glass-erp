# r2_2a_test_setup.ps1 -- creates batch-2a verification fixtures
#  * role ZZ_2A_TEST (portal) with perms: cutting.access, remnants.access, layout.access
#  * user zz_2a/zz2a123       (role string 'admin' bypasses device; role_id drives enforce)
#  * user zz_worker/zzworker123 on Worker role (id 3) for the customers-list fix check
$ErrorActionPreference = "Stop"
$js = @'
const path = require("path");
const bcrypt = require("bcryptjs");
const m = require(path.join(process.cwd(), "db"));
const db = (m && typeof m.prepare === "function") ? m : (m.db || m.default || m);

function roleId(name){ const r = db.prepare("SELECT id FROM roles WHERE name=?").get(name); return r && r.id; }

// 1) portal test role + perms
db.prepare("INSERT OR IGNORE INTO roles(name,description,is_system,superadmin,portal_access,workerapp_access) VALUES(?,?,0,0,1,0)")
  .run("ZZ_2A_TEST","batch-2a verification role");
const rid = roleId("ZZ_2A_TEST");
db.prepare("DELETE FROM role_permissions WHERE role_id=?").run(rid);
const ins = db.prepare("INSERT OR IGNORE INTO role_permissions(role_id,perm_key) VALUES(?,?)");
["cutting.access","remnants.access","layout.access"].forEach(k => ins.run(rid, k));

// 2) portal test user
const ph = bcrypt.hashSync("zz2a123", 10);
db.prepare("DELETE FROM workers WHERE email=?").run("zz_2a");
db.prepare("INSERT INTO workers(name,email,pass_hash,role,processes,is_active,role_id) VALUES(?,?,?,?,?,1,?)")
  .run("ZZ 2A Test","zz_2a",ph,"admin","[]",rid);

// 3) worker test user on Worker role
const wRole = roleId("Worker") || 3;
const wph = bcrypt.hashSync("zzworker123", 10);
db.prepare("DELETE FROM workers WHERE email=?").run("zz_worker");
db.prepare("INSERT INTO workers(name,email,pass_hash,role,processes,is_active,role_id) VALUES(?,?,?,?,?,1,?)")
  .run("ZZ Worker Test","zz_worker",wph,"admin","[]",wRole);

console.log("READY: zz_2a/zz2a123 (role ZZ_2A_TEST id "+rid+", perms cutting/remnants/layout .access); zz_worker/zzworker123 (Worker role id "+wRole+")");
'@
$tmp = "C:\agi-server\_zz_2a_setup.js"
Set-Content -Path $tmp -Value $js -Encoding ascii
Push-Location "C:\agi-server"
node $tmp
Pop-Location
Remove-Item $tmp -Force
