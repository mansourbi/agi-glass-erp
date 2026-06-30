# r2_2b_test_setup.ps1 -- creates batch-2b verification fixtures
#  * role ZZ_2B_TEST (portal) with perms: deliveries.access, tracking.access
#  * user zz_2b/zz2b123        (role string 'admin' bypasses device; role_id drives enforce)
#  * user zz_worker/zzworker123 on Worker role (id 3) -- proves worker Deliver+scan any-of
$ErrorActionPreference = "Stop"
$js = @'
const path = require("path");
const bcrypt = require("bcryptjs");
const m = require(path.join(process.cwd(), "db"));
const db = (m && typeof m.prepare === "function") ? m : (m.db || m.default || m);

function roleId(name){ const r = db.prepare("SELECT id FROM roles WHERE name=?").get(name); return r && r.id; }

// 1) portal test role + perms (reads only)
db.prepare("INSERT OR IGNORE INTO roles(name,description,is_system,superadmin,portal_access,workerapp_access) VALUES(?,?,0,0,1,0)")
  .run("ZZ_2B_TEST","batch-2b verification role");
const rid = roleId("ZZ_2B_TEST");
db.prepare("DELETE FROM role_permissions WHERE role_id=?").run(rid);
const ins = db.prepare("INSERT OR IGNORE INTO role_permissions(role_id,perm_key) VALUES(?,?)");
["deliveries.access","tracking.access"].forEach(k => ins.run(rid, k));

// 2) portal test user
const ph = bcrypt.hashSync("zz2b123", 10);
db.prepare("DELETE FROM workers WHERE email=?").run("zz_2b");
db.prepare("INSERT INTO workers(name,email,pass_hash,role,processes,is_active,role_id) VALUES(?,?,?,?,?,1,?)")
  .run("ZZ 2B Test","zz_2b",ph,"admin","[]",rid);

// 3) worker test user on Worker role
const wRole = roleId("Worker") || 3;
const wph = bcrypt.hashSync("zzworker123", 10);
db.prepare("DELETE FROM workers WHERE email=?").run("zz_worker");
db.prepare("INSERT INTO workers(name,email,pass_hash,role,processes,is_active,role_id) VALUES(?,?,?,?,?,1,?)")
  .run("ZZ Worker Test","zz_worker",wph,"admin","[]",wRole);

console.log("READY: zz_2b/zz2b123 (role ZZ_2B_TEST id "+rid+", perms deliveries.access+tracking.access); zz_worker/zzworker123 (Worker role id "+wRole+")");
'@
$tmp = "C:\agi-server\_zz_2b_setup.js"
Set-Content -Path $tmp -Value $js -Encoding ascii
Push-Location "C:\agi-server"
node $tmp
Pop-Location
Remove-Item $tmp -Force
