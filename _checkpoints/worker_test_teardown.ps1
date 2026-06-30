$srv='C:\agi-server'; $js=Join-Path $srv '_tmp_wk_teardown.js'
$code = @'
const db=require("./db");
const w=db.prepare("DELETE FROM workers WHERE email='zz_worker'").run();
console.log("CLEANED: removed zz_worker ("+w.changes+")");
'@
Set-Content -Path $js -Value $code -Encoding ascii
Push-Location $srv; node $js; Pop-Location; Remove-Item $js -Force
