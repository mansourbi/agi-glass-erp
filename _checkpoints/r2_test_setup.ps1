# Creates a TEMPORARY restricted role + test user to prove enforcement (login: zz_test / zztest123).
# Role string is 'admin' only so login skips the device check; role_id points to the LIMITED role,
# so enforcement (which uses role_id) restricts it to [portal.access, customers.access].
$srv = 'C:\agi-server'
$js  = Join-Path $srv '_tmp_r2_setup.js'
$code = @'
const db=require("./db");
const bcrypt=require("bcryptjs");
const now=new Date().toISOString();
let role=db.prepare("SELECT id FROM roles WHERE name='ZZ_TEST_LIMITED'").get();
if(!role){ const r=db.prepare("INSERT INTO roles(name,description,is_system,superadmin,portal_access,workerapp_access,created_at,updated_at) VALUES('ZZ_TEST_LIMITED','TEMP enforcement test - safe to delete',0,0,1,0,?,?)").run(now,now); role={id:r.lastInsertRowid}; }
db.prepare("DELETE FROM role_permissions WHERE role_id=?").run(role.id);
["portal.access","customers.access"].forEach(k=>db.prepare("INSERT OR IGNORE INTO role_permissions(role_id,perm_key) VALUES(?,?)").run(role.id,k));
const hash=bcrypt.hashSync("zztest123",10);
const u=db.prepare("SELECT id FROM workers WHERE email='zz_test'").get();
if(u){ db.prepare("UPDATE workers SET pass_hash=?, role='admin', role_id=?, is_active=1 WHERE id=?").run(hash,role.id,u.id); }
else { db.prepare("INSERT INTO workers(name,email,pass_hash,role,role_id,processes,is_active,created_at) VALUES('ZZ Test','zz_test',?,'admin',?,'[]',1,?)").run(hash,role.id,now); }
console.log("READY: role ZZ_TEST_LIMITED (id "+role.id+") = [portal.access, customers.access]; user zz_test / zztest123");
'@
Set-Content -Path $js -Value $code -Encoding ascii
Push-Location $srv; node $js; Pop-Location
Remove-Item $js -Force
