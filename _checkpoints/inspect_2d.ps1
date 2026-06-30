# inspect_2d.ps1 -- read-only dump of route declarations for the remaining (Settings + HR) files
$ErrorActionPreference = "Stop"

Write-Host "===== server.js inline /api handlers + config ====="
Select-String -Path "C:\agi-server\server.js" -Pattern "app\.(get|post|put|patch|delete)\(\s*['""]/api" | ForEach-Object {
  Write-Host ("  [L" + $_.LineNumber + "] " + $_.Line.Trim())
}
Write-Host ""

# explicit list of the route files not yet mapped in batches 1/2a/2b/2c
$targets = @(
  "auth.js","access.js","workers.js","attendance.js","hr.js","holidays.js",
  "factories.js","translations.js","audit.js","config.js",
  "glassfamilies.js","finalproducts.js","fpfields.js","rawsheets.js",
  "external_processes.js","sheetowner.js","gsheets.js","customerprices.js"
)
foreach($name in $targets){
  $p = "C:\agi-server\routes\$name"
  if(!(Test-Path $p)){ continue }
  Write-Host ("===== " + $name + " =====")
  Select-String -Path $p -Pattern "router\.(get|post|put|patch|delete|use)\(" | ForEach-Object {
    Write-Host ("  [L" + $_.LineNumber + "] " + $_.Line.Trim())
  }
  Write-Host ""
}
Write-Host "===== done ====="
