---
description: Read-only health check of the agi-glass service (safe, no writes)
---

Check whether the ERP is healthy. **Read-only — change nothing.**

Run these and report a short verdict table:

1. Service state: `Get-Service agi-glass | Select-Object Status, StartType`
2. Listeners: `Get-NetTCPConnection -LocalPort 3000,3444 -State Listen |
   Select-Object LocalPort, OwningProcess`
3. Owning process identity — confirm it is `node.exe` and note `StartTime`.
   A **blank StartTime** means the SYSTEM-owned node process.
4. Health endpoint: `Invoke-RestMethod http://localhost:3000/api/health`
   Healthy = `status: ok`, `db: connected`.
5. Tail of `logs\stdout.log` — look for a recent
   `[DB] SQLite ready: C:\AGI\agi-server\agi-glass.db`.
6. Confirm `netsh interface portproxy show all` is empty. Any proxy on
   3000/3444 is a leftover from a retired boot script and fights node for
   the port.

Report each as pass/fail with the actual value seen. Do not restart anything
and do not propose fixes unless something fails.
