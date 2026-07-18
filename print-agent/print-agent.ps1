# C:\agi-print-agent\print-agent.ps1  -- AGI network print relay agent (headless-PDF)
# ---------------------------------------------------------------------------
# Polls the Dell server for pending print jobs, renders each label page to PDF
# via headless Edge, and prints to the TSC TE244 via SumatraPDF.
#
# SETUP: see SETUP.md in this folder. Before running, replace the token below
# with the real agent token (must match the server's print-agent-token.txt).
# ---------------------------------------------------------------------------
$ErrorActionPreference = 'Continue'
$SERVER      = 'http://192.168.1.14:3000'       # Dell server (DHCP-reserved IP)
$TOKEN       = 'REPLACE_WITH_AGENT_TOKEN'        # must match server print-agent-token.txt
$PRINTER     = 'TSC TE244'                       # Windows printer name (has a space)
$PRINT_SET   = 'landscape,noscale'               # SumatraPDF print settings for TE244
$EDGE        = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$EDGEPROF    = 'C:\agi-print-agent\edge-profile'
$SUMATRA     = 'C:\agi-print-agent\sumatra\SumatraPDF.exe'
$TMPDIR      = 'C:\agi-print-agent\tmp'
$LOG         = 'C:\agi-print-agent\agent.log'
$POLL_SEC    = 2
New-Item -ItemType Directory -Force -Path $TMPDIR | Out-Null
function Log($m){ "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $m" | Out-File -Append -Encoding utf8 $LOG }
Log "agent starting (server=$SERVER printer=$PRINTER mode=headless-pdf)"
while ($true) {
  try {
    $jobs = Invoke-RestMethod -Uri "$SERVER/api/print/pending" -Headers @{'x-agent-token'=$TOKEN} -TimeoutSec 10
    foreach ($j in $jobs) {
      $id = $j.id
      try {
        if ($j.label_type -in @('remnant','html','piece') -and ($j.ref -or $j.label_type -in @('html','piece'))) {
          # ---- HEADLESS PATH: render label page -> PDF -> print via SumatraPDF ----
          $pdf = Join-Path $TMPDIR "job_$id.pdf"
          if ($j.label_type -eq 'remnant') { $url = "$SERVER/print-label/remnant/$($j.ref)" } else { $url = "$SERVER/print-label/job/$id" }
          $rendered = $false
          foreach ($attempt in 1..2) {
            $prof = Join-Path $TMPDIR ("prof_" + $id + "_" + (Get-Random))
            Remove-Item $pdf -ErrorAction SilentlyContinue
            & $EDGE --headless=new --disable-gpu --no-first-run --no-default-browser-check `
                --user-data-dir="$prof" --virtual-time-budget=2500 `
                --print-to-pdf="$pdf" --print-to-pdf-no-header "$url" 2>$null
            $deadline = (Get-Date).AddSeconds(8)
            while (-not (Test-Path $pdf) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 200 }
            Remove-Item $prof -Recurse -Force -ErrorAction SilentlyContinue
            if (Test-Path $pdf) { $rendered = $true; break }
            Log "job $id render attempt $attempt failed, retrying"
            Start-Sleep -Milliseconds 600
          }
          if ($rendered) {
            & $SUMATRA -print-to "$PRINTER" -print-settings "$PRINT_SET" -silent $pdf
            Start-Sleep -Milliseconds 800
            Invoke-RestMethod -Uri "$SERVER/api/print/$id/done" -Method POST -Headers @{'x-agent-token'=$TOKEN} -TimeoutSec 10 | Out-Null
            Log "job $id printed OK (headless ref=$($j.ref))"
          } else {
            $msg = 'PDF not generated after 2 attempts'
            Invoke-RestMethod -Uri "$SERVER/api/print/$id/error" -Method POST -Headers @{'x-agent-token'=$TOKEN} -Body (@{error=$msg}|ConvertTo-Json) -ContentType 'application/json' -TimeoutSec 10 | Out-Null
            Log "job $id ERROR: $msg"
          }
          Remove-Item $pdf -ErrorAction SilentlyContinue
        } else {
          # ---- LEGACY TSPL PATH (fallback for non-remnant / no-ref jobs) ----
          $tmp = Join-Path $TMPDIR "job_$id.tspl"
          if ($j.tspl.StartsWith('B64:')) { [System.IO.File]::WriteAllBytes($tmp, [System.Convert]::FromBase64String($j.tspl.Substring(4))) }
          else { [System.IO.File]::WriteAllText($tmp, $j.tspl, (New-Object System.Text.ASCIIEncoding)) }
          $out = cmd /c "copy /b `"$tmp`" `"\\localhost\TSC_TE244`"" 2>&1
          if ($LASTEXITCODE -eq 0) {
            Invoke-RestMethod -Uri "$SERVER/api/print/$id/done" -Method POST -Headers @{'x-agent-token'=$TOKEN} -TimeoutSec 10 | Out-Null
            Log "job $id printed OK (legacy tspl)"
          } else {
            $msg = "copy failed: $out"
            Invoke-RestMethod -Uri "$SERVER/api/print/$id/error" -Method POST -Headers @{'x-agent-token'=$TOKEN} -Body (@{error=$msg}|ConvertTo-Json) -ContentType 'application/json' -TimeoutSec 10 | Out-Null
            Log "job $id ERROR: $msg"
          }
          Remove-Item $tmp -ErrorAction SilentlyContinue
        }
      } catch {
        $msg = $_.Exception.Message
        try { Invoke-RestMethod -Uri "$SERVER/api/print/$id/error" -Method POST -Headers @{'x-agent-token'=$TOKEN} -Body (@{error=$msg}|ConvertTo-Json) -ContentType 'application/json' -TimeoutSec 10 | Out-Null } catch {}
        Log "job $id EXCEPTION: $msg"
      }
    }
  } catch {
    Log "poll error: $($_.Exception.Message)"
    Start-Sleep -Seconds 5
  }
  Start-Sleep -Seconds $POLL_SEC
}
