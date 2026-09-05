# AGI Glass Factory ERP

In-house ERP for a glass fabrication factory in Amman: orders, cutting
optimization, deliveries, HR/payroll, stock/slots, remnants, label printing,
worker operations. Single operator/owner (Ala) is the only developer and the
factory decision-maker.

## System

- Backend: Node.js / Express / SQLite (better-sqlite3, WAL). DB: `agi-glass.db`.
- Process manager: pm2, service name `agi-glass`. Ports 3000 (HTTP) / 3444 (HTTPS mobile).
- Server: Dell at 192.168.1.14. Portal: `http://192.168.1.14:3000/glassfab.html`
- **This checkout IS the deployed location.** Editing a file here changes production.
- Frontend: `public/glassfab.html` (single-file admin portal, ~22k lines),
  `public/glassfab-worker.html` (worker PWA), `public/agi-api.js` (API client).
- Routes in `routes/`. Backups in `_public_backups/`, `_route_backups/`, `_db_backups/`
  (timestamp + TAG naming).
- Print station: AMRODELL-LAPTOP + TSC TE244 (100x50mm labels), headless-Edge PDF
  relay agent. See `print-agent/SETUP.md`.
- Git remote: `mansourbi/agi-glass-erp`.

HTML changes need only a hard refresh. Route changes need a restart.

### Restart (zombie-safe)

```powershell
pm2 delete agi-glass
Get-NetTCPConnection -LocalPort 3000,3444 -State Listen -EA SilentlyContinue |
  Select-Object -Expand OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force }
pm2 start C:\agi-server\server.js --name agi-glass
pm2 save
```

## Data protection — hard rules

This is a live factory database. Real orders, real payroll, real deliveries.

- **Never** alter customer, order, tracking, delivery, or sheet/stock data as a
  side effect of coding. Data fixes happen only when explicitly working on
  fixing that data.
- Data fixes require: show the exact rows first, get confirmation, back up all
  three DB files (`.db`, `-wal`, `-shm`), use a transaction with guards, and
  stamp manual inserts with `added_by_name='Admin (manual add)'`.
- Open the DB `{ readonly: true }` for any diagnostic. Default to read-only.
- **Don't change the past.** Saved optimization files, finalized deliveries,
  printed labels, and historical production records stay as saved. New logic
  applies only to new runs.
- Never trigger a physical print during testing.
- Never save optimization results during diagnosis.
- Never overwrite `glassfab-worker.html` without first confirming the Deliver
  tab exists in the replacement.

## Working protocol

1. **Diagnose read-only first.** Never guess or invent data. Verify the exact
   rows or the exact code before proposing a change. Ala has corrected
   fabricated numbers before — investigate, then propose.
2. Back up the file before editing it (timestamped, into the matching
   `_*_backups/` dir).
3. On failure or regression: **revert from backup first, then diagnose.**
4. **Verification is mandatory** before calling anything done. Passing syntax
   checks and anchor counts is not proof — the change has to be seen working on
   the live screen. Ask Ala to check the real UI.
5. Before declaring a regression, confirm the comparison is apples-to-apples:
   same settings, same inputs, same tab state. Several past "bugs" were stale
   tab state or correct behavior.
6. Ask before guessing. A clarifying question is cheaper than a bad write.

## Code conventions

- Express: specific routes must be declared **before** `:param` routes.
- Every `AGI.Orders.list()` call site needs `include_items: 1`, or orders load
  with no items, processes, or thickness.
- Slot inventory sum is the truth for warehouse stock — not `stock_qty` on the
  catalog row.
- DB columns are `company` (not `brand`) and `glass_type` (not `type`).
- Validate with `node --check` before restarting. Note it catches syntax errors
  but not runtime `ReferenceError`s — hoist functions used in multiple places to
  module scope.
- After editing a long block, verify adjacent function declarations survived.
- New portal features are added as guarded overlays with a marker comment
  (e.g. `SALES_REPORT v1`) appended before `</body>`, not inline edits to the
  monolith.
- Every UI change includes Arabic handling: `data-i18n` attributes plus
  translation entries.

## Git

Commit at session end, or after each verified feature. Version tags (`v1.NN`)
plus a clear multi-line description. Push to `origin main --tags` — a local-only
commit is not safe, the DB and repo both live on the same Dell.

<!-- Ongoing work and carry-over items are NOT tracked here on purpose.
     Keep them in docs/HANDOFF.md and point Claude at it at session start. -->
