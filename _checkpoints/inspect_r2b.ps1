# READ-ONLY: dump route definitions for the Cutting cluster + Tracking endpoints
# so the R-2 batch-2 permission map is exact. Nothing is modified.
$srv = 'C:\agi-server\routes'
foreach ($f in @('cutting.js','optfiles.js','labels.js','reports.js')) {
  Write-Host ("===== " + $f + " =====")
  Select-String -Path (Join-Path $srv $f) -Pattern "router\.(get|post|put|patch|delete)\(" |
    ForEach-Object {
      $line = $_.Line.Trim()
      if ($line.Length -gt 130) { $line = $line.Substring(0,130) }
      Write-Host ("  " + $_.LineNumber.ToString() + ": " + $line)
    }
  Write-Host ""
}
