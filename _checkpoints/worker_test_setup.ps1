# Creates a TEMP user on the real Worker role to verify worker-app order access.
# role string 'admin' only so login skips the device check; role_id = Worker role.
$srv='C:\agi-server'; $js=Join-Path $srv '_tmp_wk_setup.js'
$code = @'
const db=require("./db"); const bcrypt=require("bcryptjs");
const wk=db.prepare("SELECT id FROM roles WHERE name='Worker'").get();
if(!wk){ console.log("ERR: Worker role not found"); process.exit(1); }
const now=new Date().toISOString(); const hash=bcrypt.hashSync("zzworker123",10);
const u=db.prepare("SELECT id FROM workers WHERE email='zz_worker'").get();
if(u){ db.prepare("UPDATE workers SET pass_hash=?, role='admin', role_id=?, is_active=1 WHERE id=?").run(hash,wk.id,u.id); }
else { db.prepare("INSERT INTO workers(name,email,pass_hash,role,role_id,processes,is_active,created_at) VALUES('ZZ Worker','zz_worker',?,'admin',?,'[]',1,?)").run(hash,wk.id,now); }
console.log("READY: zz_worker / zzworker123 on Worker role (id "+wk.id+")");
'@
Set-Content -Path $js -Value $code -Encoding ascii
Push-Location $srv; node $js; Pop-Location; Remove-Item $js -Force
