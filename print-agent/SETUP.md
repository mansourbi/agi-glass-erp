# AGI Network Print Agent — Setup

Prints thermal labels (100×50mm, TSC TE244) from any device on the LAN.
Any device enqueues a job on the Dell server; this agent (on the laptop with the
USB printer) polls, renders the label to PDF via headless Edge, and prints it.

```
Portal / Worker app  →  Dell server (print_jobs queue)  →  Laptop agent  →  TSC TE244
   (any device)          192.168.1.14:3000                (this machine)     (USB)
```

## Why headless Edge → PDF → SumatraPDF
Earlier approaches (plain TSPL text; client html2canvas→PNG→bitmap) either didn't
match the browser label or clipped. The server serves the *exact* label HTML/CSS at
`/print-label/...`, headless Edge renders it to PDF, so output is identical to the
browser's Print button. SumatraPDF then prints the PDF with `landscape,noscale`.

## Server side (Dell) — already in the repo
- `routes/print.js` — `print_jobs` queue; client enqueue endpoints; agent endpoints
  `GET /api/print/pending`, `POST /api/print/:id/done`, `POST /api/print/:id/error`
  (all require header `x-agent-token`). Also `POST /api/print/html` (browser sends
  finished label HTML for piece/session labels).
- `routes/printlabel.js` — `GET /print-label/remnant/:idOrUid` and
  `GET /print-label/job/:id` serve standalone label pages for Edge to render.
- Agent token lives in `C:\agi-server\print-agent-token.txt` (gitignored). The same
  token must go in the agent's `$TOKEN`.

## Laptop station requirements
- **Printer**: `TSC TE244` installed (Windows name has a space; share is `TSC_TE244`).
- **Edge**: ships with Windows. Path: `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`.
- **SumatraPDF portable**: `C:\agi-print-agent\sumatra\SumatraPDF.exe` (v3.5.2+).
  Download the 64-bit portable from https://www.sumatrapdfreader.org and place it there.
- **Agent script**: copy `print-agent.ps1` to `C:\agi-print-agent\print-agent.ps1`
  and set `$TOKEN` to the real value from the server's `print-agent-token.txt`.

## Install steps
1. Create `C:\agi-print-agent\` and subfolders `sumatra\`, `tmp\`.
2. Put `SumatraPDF.exe` in `sumatra\`.
3. Copy `print-agent.ps1` in, edit `$TOKEN` (and `$SERVER` if the Dell IP changes).
4. Register the scheduled task (below).
5. Enable auto-login (below) so the station recovers unattended after a reboot.

## Scheduled task — MUST run interactively
> **Critical:** headless Edge does **not** work under the SYSTEM account or in a
> non-interactive session 0 — it produces no PDF ("PDF not generated"). It needs a
> real interactive desktop. So the task runs as the logged-in user at logon, and the
> machine auto-logs-in on boot to guarantee that desktop exists.

Run in an **elevated PowerShell** on the laptop (replace user if different):
```powershell
$user = "amrodell-laptop\admin"
$action  = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\agi-print-agent\print-agent.ps1"'
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Highest
Register-ScheduledTask -TaskName 'AGI Print Agent' -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal -Force
```

## Auto-login (so it recovers unattended after reboot)
Stores the password in the registry — acceptable for a dedicated LAN print station.
Run elevated:
```powershell
$RegPath = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
$pw = Read-Host "Enter the admin Windows password (for auto-login)" -AsSecureString
$pwPlain = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($pw))
Set-ItemProperty $RegPath 'AutoAdminLogon' '1'
Set-ItemProperty $RegPath 'DefaultUserName' 'admin'
Set-ItemProperty $RegPath 'DefaultDomainName' 'amrodell-laptop'
Set-ItemProperty $RegPath 'DefaultPassword' $pwPlain
```
After a reboot the laptop auto-logs into the admin desktop → the task fires at logon
→ Edge has a desktop → printing works with nobody touching the machine.

## Manual test
```powershell
# stop the task, run the agent in the foreground:
Stop-ScheduledTask -TaskName 'AGI Print Agent'
powershell -NoProfile -ExecutionPolicy Bypass -File 'C:\agi-print-agent\print-agent.ps1'
# then enqueue a print from any device; watch the printer; Ctrl+C to stop.
tail -like:  Get-Content 'C:\agi-print-agent\agent.log' -Tail 6
```

## Reliability notes (hard-won)
- **Unique Edge profile per job** (`tmp\prof_<id>_<rand>`) + one retry. Without this,
  a shared `edge-profile` dir gets locked/stale and every other job fails with
  "PDF not generated." The per-job profile removes the contention.
- **Restarting the agent**: `Stop-ScheduledTask` then `Start-ScheduledTask`. It's an
  infinite poll loop; a quiet console is normal (it only writes to `agent.log`).
- **Print orientation**: `landscape,noscale`. The TE244 driver rotates; this setting
  produces correct 100×50mm landscape output.

## Network
- Dell server pinned to **192.168.1.14** via the Nokia router's static DHCP lease
  (Network Parameters → DHCP → Static DHCP leases), so it survives reboots.
- If the Dell IP ever changes, update `$SERVER` in `print-agent.ps1`.

## Server restart reminder (Dell, pm2)
`pm2 restart` is unreliable on that box (leaves a zombie holding the port, serving
stale code). Reliable restart:
```powershell
pm2 delete agi-glass
Get-NetTCPConnection -LocalPort 3000,3444 -State Listen | Select -Expand OwningProcess -Unique | % { Stop-Process -Id $_ -Force }
pm2 start C:\agi-server\server.js --name agi-glass
pm2 save
```
