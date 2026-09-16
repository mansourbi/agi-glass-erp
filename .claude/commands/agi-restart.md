---
description: Restart the agi-glass service safely, with syntax gate and health verification
---

Restart the ERP after a **route change**. HTML-only changes need no restart —
a hard refresh is enough, so confirm a restart is actually required first.

NSSM is the **only** supervisor. pm2, the WSL boot task and the `.bat` task
were retired 2026-09-14 — never revive them.

## Order of operations

1. **Syntax gate first.** `node --check` every `.js` file you changed.
   If any check fails, stop here and report. Never restart on a failed check.
2. Gate the restart on that exit code:
   `if ($LASTEXITCODE -eq 0) { Restart-Service agi-glass }`
   Also confirm the patched file exists and is non-empty — a here-string that
   wrote nothing still lets a later restart line run and take production down.
3. Wait ~8 seconds. Migrations run at startup.
4. Verify, do not assume:
   - `[DB] SQLite ready: C:\AGI\agi-server\agi-glass.db` freshly appended to
     `logs\stdout.log`
   - listeners on 3000/3444 owned by `node.exe` with `StartTime` = now
   - `/api/health` returns `db: connected`
5. Report the verified result. "Service says Running" is not verification.

## If it wedges

```
Stop-Service agi-glass -Force
Get-NetTCPConnection -LocalPort 3000,3444 -State Listen
taskkill /F /PID <pid>        # elevated shell
Start-Service agi-glass
```

`Stop-Process` fails silently on the SYSTEM-owned node — a blank `StartTime`
in `Get-Process` identifies that process. Then confirm
`netsh interface portproxy show all` is empty.

## If the restart made things worse

**Restore from backup first, diagnose second.** Backups are in
`_route_backups\` as `name.TIMESTAMP.TAG`.
