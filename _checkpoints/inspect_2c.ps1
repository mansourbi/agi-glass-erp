# inspect_2c.ps1 -- read-only dump of mount paths + route declarations for batch 2c
$ErrorActionPreference = "Stop"
Write-Host "===== server.js route mounts ====="
Select-String -Path "C:\agi-server\server.js" -Pattern "app\.use\(\s*['""]/api" | ForEach-Object {
  Write-Host ("  [L" + $_.LineNumber + "] " + $_.Line.Trim())
}
Write-Host ""
$files = Get-ChildItem "C:\agi-server\routes\*.js" | Where-Object { $_.Name -match 'report|pricing|purchas' }
foreach($f in $files){
  Write-Host ("===== " + $f.Name + " =====")
  # top-of-file middleware mounts (router.use) + every route declaration with its inline middleware
  Select-String -Path $f.FullName -Pattern "router\.(get|post|put|patch|delete|use)\(" | ForEach-Object {
    Write-Host ("  [L" + $_.LineNumber + "] " + $_.Line.Trim())
  }
  Write-Host ""
}
Write-Host "===== done ====="
