# r2_2dii_test_setup.ps1 -- creates batch-2d-ii verification fixtures (dual: portal + worker)
#  * role ZZ_2DII_TEST (portal) perms: hr.attendance.view, hr.leave.view, hr.overtime.view
#  * user zz_2dii/zz2dii123      (role string 'admin' bypasses device; role_id drives enforce)
#  * user zz_worker/zzworker123  on Worker role (id 3) -- proves attendance/hr worker any-of
$ErrorActionPreference = "Stop"
$js = @'
const path = require("path");
const bcrypt = require("bcryptjs");
const m = require(path.join(process.cwd(), "db"));
const db = (m && typeof m.prepare === "function") ? m : (m.db || m.default || m);
function roleId(name){ const r = db.prepare("SELECT id FROM roles WHERE name=?").get(name); return r && r.id; }

db.prepare("INSERT OR IGNORE INTO roles(name,description,is_system,superadmin,portal_access,workerapp_access) VALUES(?,?,0,0,1,0)")
  .run("ZZ_2DII_TEST","batch-2d-ii verification role");
const rid = roleId("ZZ_2DII_TEST");
db.prepare("DELETE FROM role_permissions WHERE role_id=?").run(rid);
const ins = db.prepare("INSERT OR IGNORE INTO role_permissions(role_id,perm_key) VALUES(?,?)");
["hr.attendance.view","hr.leave.view","hr.overtime.view"].forEach(k => ins.run(rid, k));

const ph = bcrypt.hashSync("zz2dii123", 10);
db.prepare("DELETE FROM workers WHERE email=?").run("zz_2dii");
db.prepare("INSERT INTO workers(name,email,pass_hash,role,processes,is_active,role_id) VALUES(?,?,?,?,?,1,?)")
  .run("ZZ 2DII Test","zz_2dii",ph,"admin","[]",rid);

const wRole = roleId("Worker") || 3;
const wph = bcrypt.hashSync("zzworker123", 10);
db.prepare("DELETE FROM workers WHERE email=?").run("zz_worker");
db.prepare("INSERT INTO workers(name,email,pass_hash,role,processes,is_active,role_id) VALUES(?,?,?,?,?,1,?)")
  .run("ZZ Worker Test","zz_worker",wph,"admin","[]",wRole);

console.log("READY: zz_2dii/zz2dii123 (role ZZ_2DII_TEST id "+rid+", perms hr.attendance.view+hr.leave.view+hr.overtime.view); zz_worker/zzworker123 (Worker role id "+wRole+")");
'@
$tmp = "C:\agi-server\_zz_2dii_setup.js"
Set-Content -Path $tmp -Value $js -Encoding ascii
Push-Location "C:\agi-server"
node $tmp
Pop-Location
Remove-Item $tmp -Force
