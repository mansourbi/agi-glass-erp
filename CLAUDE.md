# CLAUDE.md — AGI Glass ERP

Context for AI sessions working on this repository. Read this before touching anything.

---

## 1. What this is

Custom in-house ERP for **AGI Glass Factory (فن الزجاج للصناعات الزجاجية)**, Amman, Jordan.
Glass fabrication: cutting, edging, drilling, cut-outs, tempering (outsourced), delivery.
Built and maintained by the owner, **Ala**, who is also the primary decision-maker.

Not a product. A working factory depends on it daily — orders, stock, payroll, deliveries.
Breakage costs real money and real time.

**Sister company:** Reflections Glass owns the glass and mirror stock. AGI charges for
*fabrication*, not material. This matters for pricing (see §6).

---

## 2. Stack and layout

| | |
|---|---|
| Runtime | Node.js + Express, **better-sqlite3** (synchronous), pm2 service `agi-glass` |
| Database | `C:\agi-server\agi-glass.db` — SQLite WAL, ~92 tables, ~51k rows, ~163 MB |
| Ports | 3000 HTTP (desktop), 3444 HTTPS (mobile) |
| Server | Dell box, `192.168.1.14` (`.15` also seen in older notes — verify) |
| Admin UI | `public/glassfab.html` — single file, ~26k lines |
| Worker PWA | `public/glassfab-worker.html` — phone app for the floor |
| Repo | `C:\agi-server` **is** the deployment; remote `mansourbi/agi-glass-erp` |
| Backups | `_public_backups\`, `_route_backups\`, `_db_backups\` (`name.TIMESTAMP.TAG`) |
| Print | AMRODELL-LAPTOP + TSC TE244, 100×50mm labels, headless-Edge PDF relay |

HTML changes need only a hard refresh. **Route changes need a restart.**

---

## 3. Working protocol (learned the hard way)

1. **Diagnose read-only first.** Never guess at data. Show the exact rows before proposing
   a change. Ala has corrected fabricated numbers more than once — investigate, then
   propose.
2. **Patch via anchored Node scripts**, not by hand-editing: PowerShell here-string →
   temp `.js` → `rep(name, oldExact, new)` with a **count guard that aborts the whole write
   if any anchor doesn't match exactly once**. This has prevented several bad edits. Take
   a timestamped backup before every patch.
3. **`node --check` before restarting**, and gate the restart on it:
   `if ($LASTEXITCODE -eq 0) { ...restart... }`. Gate on the *patch script's* exit code
   too — a later command's success is not the patch's success.
4. **Verify on the live screen.** Passing anchor counts is not proof. Claude checks via the
   Chrome extension; Ala checks the real UI.
5. **On regression: restore from backup first, diagnose second.**
6. Before declaring a regression, confirm it is apples-to-apples (same filters, same data).

### Restart procedure
```powershell
pm2 delete agi-glass
netstat -ano | findstr ":3000"        # note PID
taskkill /F /PID <pid>                # REQUIRES ADMINISTRATOR
pm2 start C:\agi-server\server.js --name agi-glass
pm2 save
```
**A stale process silently held port 3000 for hours once**, so every "restart" started a
new instance that died with `EADDRINUSE` while old code kept serving. If a new route 404s,
check who owns the port before debugging the code. `Stop-Process` fails on the
SYSTEM-owned process — use `taskkill` from an elevated shell.

Healthy = `pm2 status` shows `online` with `↺ 0`, fresh boot lines in the **out** log
(`[DB] SQLite ready`), and an API probe returning **401** (auth-gated, so alive). The
error log mixes stale entries — don't trust it alone.

---

## 4. Data protection (hard rules)

- **Never alter customer, order, tracking, delivery or stock data while coding.** Data fixes
  are their own task: show the rows, get explicit confirmation, use a transaction, back up
  first, stamp manual inserts `added_by_name='Admin (manual add)'`.
- **Don't change the past.** Saved optimizations, finalised deliveries, printed labels and
  historical production records stay as they are. New logic applies to new work.
- Never trigger physical prints during tests. Never save optimizer results while diagnosing.

---

## 5. Landmines

**Timezone split — the database mixes conventions.**
UTC: `orders.created_at`, `scan_log.ts`, `label_items`, `opt_files`, `slot_inventory`,
`deliveries`. Local (UTC+3): `audit_log.ts`, `attendance.*`, `raw_sheet_transactions`,
`worker_salary_history`. Comparing across the two without normalising is off by 3 hours.
This produced a wrong answer to "why did this order take so long" before it was caught.

**String comparison on timestamps.** Stored form is `YYYY-MM-DD HH:MM:SS` (space). ISO
input with `T` silently drops rows, because `' ' < 'T'`. This had broken **ten query sites**
across reports, labels and remnants — entire days vanished from reports. Normalise the
separator at every date parameter.

**`new Date('YYYY-MM-DD')` parses as UTC.** Inside a local-time loop this skips days. It
made a 22.7-hour gap read as 5.7. Build dates explicitly from local parts.

**Base64 in the database.** Order attachments (59 MB) and worker photos live as base64
columns. `SELECT o.*` on a list endpoint shipped **62 MB per page load**. Always exclude
heavy columns from list endpoints; fetch the full record when a single item is opened.
Any time a list is slimmed, **grep every consumer of the removed field first** — this was
missed twice, breaking attachment display and cutting-file opening.

**Sheet cutting movements are bookkeeping, not production.** Shweiki records them in the
office afterwards, in batches. Never use `cutting_movements.movement_date` as a machine
timestamp. Piece scans are the production truth — but even those contain batch-scan bursts
(41 pieces logged in 14 minutes) that must be filtered from any rate calculation.

**`workers.email` is a username**, by convention (`admin`, `hussein`, `nidal`). The login
route calls it email; the UI label is a known lie, deliberately left alone.

**Modals.** `.mbg` has no z-index — DOM order decides stacking; use the `mbg-top` class for
nested modals. Optional fields must reset on open **and** write on restore, or values leak
between records.

**Content filter (Chrome extension).** Large source dumps, `fn.toString()` and base64 get
blocked. Use disk-side PowerShell for source reading; DOM reads and counts are fine.
`confirm()`/`prompt()` wedge extension tabs.

**Express:** specific routes before `:param` routes.

---

## 6. Domain semantics

- **Slot inventory is the source of truth** for warehouse stock, not `raw_sheets.stock_qty`.
- DB columns are `company` (not brand) and `glass_type` (not type).
- Every `AGI.Orders.list()` needs `include_items:1`.
- Material code scheme: `{THICK}{FAM}-{MFGCODE}{ORIGIN}-{COLOR}-{NN}`, e.g.
  `06FLO-SGGEGY-BRZ-01`. Manufacturer segment priority: explicit `manufacturers.code` >
  sibling sheet > COMP map > derived letters.
- Remake numbering derives from the **original** order: `REF-515-RC`, then `RC2`, `RC3`.
  `RA` = AGI fault, `RC` = customer fault, `SA` = sample, `WA` = warranty.
- **Pricing prices fabrication, not glass** (Reflections owns the material). Engine in
  `routes/pricing2.js`: per-piece minimum billable area, oversize %, manual fees at order
  or piece level, three discount modes, VAT 16%, rounding to nearest 1 JOD.
- **Payroll**: absences and lateness consume *vacation balance*, not cash. Cash is deducted
  only when the balance goes negative. See `HR-PAYROLL-SPECIFICATION.md`.
- Glass weight: `area_m² × thickness_mm × 2.5` kg.
- Closed payroll months snapshot into `payroll_runs`; open months compute live. **Close the
  month before applying raises.**

---

## 7. Conventions

- Every UI change includes Arabic handling (`data-i18n` + translation entries).
- Commit at session end or after each verified feature, with a descriptive multi-line
  message explaining *why*, not just what.
- Temp scripts use a `_` prefix and are gitignored.

---

## 8. Known open items

- Attachments should move to disk (would cut the DB by ~a third).
- The legacy `role='admin'` string bypasses `role_permissions` — a second privilege path.
- `GET /payroll` and `close-month` compute advances differently and can disagree.
- Production planning / completion-date estimator: designed, not built
  (`PRODUCTION-PLANNING-DESIGN.md`). Needs `requested_delivery_date` and `priority` on
  orders first.
- Attendance records only "done" events — no start/stop, so process vs queue time cannot
  be separated. Suggested future schema: `process_events(piece_uid, process, started_at,
  ended_at, worker_id)`.

---

## 9. Reference documents (in project knowledge)

| Document | Contents |
|---|---|
| `HR-PAYROLL-SPECIFICATION.md` | Full HR/payroll rules — rebuild-grade |
| `PRICING-FINAL-DATA-MODEL.md` | Pricing design from a structured interview (D1–D15) |
| `PRICING-SYSTEM-REDESIGN.md` | Pricing recon + industry research |
| `PRODUCTION-PLANNING-DESIGN.md` | Capacity, scheduling, estimator design |
| `SQL-MIGRATION-PLAN.md` | SQLite → Postgres plan (deferred; payload work mattered more) |
| `AGI-ERP-PROJECT-CONTEXT.md` | Earlier system manual |

---

## 10. How Ala works

Direct and decisive — expects a clear yes/no on each proposed change, prefers investigation
over speculation, and will say "ignore" or "nevermind" to close a thread. Corrects errors
plainly; getting something wrong is fine, guessing and presenting it as fact is not.

Be honest about uncertainty, flag risks *before* running something destructive, and say when
a fix is a workaround rather than a solution. When a measurement contradicts an assumption,
the measurement wins — several of this system's worst bugs were found that way.
