# CLAUDE.md — AGI Glass ERP

Context for AI sessions working on this repository. Read this before touching anything.

## 1. What this is

Custom in-house ERP for **AGI Glass Factory (فن الزجاج للصناعات الزجاجية)**, Amman, Jordan.
Glass fabrication: cutting, edging, drilling, cut-outs, tempering (outsourced), delivery.
Built and maintained by the owner, **Ala**, who is also the primary decision-maker.

Not a product. A working factory depends on it daily — breakage costs real money and time.
**Sister company:** Reflections Glass owns the stock; AGI charges for *fabrication*, not
material, which is what §6's pricing rules turn on.

## 2. Stack and layout

| | |
|---|---|
| Runtime | Node.js + Express, **better-sqlite3** (synchronous); **NSSM service `agi-glass`** (LocalSystem, auto-start, restart-on-exit) — the only supervisor |
| Database | `C:\AGI\agi-server\agi-glass.db` — SQLite WAL, ~92 tables, ~51k rows, ~163 MB |
| Ports | 3000 HTTP (desktop), 3444 HTTPS (mobile) |
| Server | Dell box, `192.168.1.14` (DHCP reservation; wired `.15` is dead — two adapters) |
| Admin UI | `public/glassfab.html` — single file, ~26k lines |
| Worker PWA | `public/glassfab-worker.html` — phone app for the floor |
| Repo | `C:\AGI\agi-server` **is** the deployment (inside the `C:\AGI` master folder); remote `mansourbi/agi-glass-erp` |
| Backups | `_public_backups\`, `_route_backups\`, `_db_backups\` (`name.TIMESTAMP.TAG`) |
| Print | AMRODELL-LAPTOP + TSC TE244, 100×50mm labels, headless-Edge PDF relay |

HTML changes need only a hard refresh. **Route changes need a restart.**

## 3. Working protocol (learned the hard way)

1. **Diagnose read-only first.** Never guess at data; show the exact rows before proposing a
   change. Ala has corrected fabricated numbers more than once — investigate, then propose.
2. **Patch via anchored Node scripts**, not by hand-editing: PowerShell here-string →
   temp `.js` → `rep(name, oldExact, new)` with a **count guard that aborts the whole write
   if any anchor doesn't match exactly once**. Anchors are **computed from the live file,
   never transcribed** (six consecutive aborts in one session), checked for mutual substring
   overlap, with an idempotency guard at the top. Timestamped backup before every patch.
3. **`node --check` before restarting**, and gate the restart on it:
   `if ($LASTEXITCODE -eq 0) { ...restart... }`. Gate on the *patch script's* exit code and
   on the file existing — a here-string that wrote nothing still lets a later "restart"
   line run and take production down.
4. **Verify on the live screen.** Passing anchor counts is not proof. Claude checks via the
   Chrome extension; Ala checks the real UI.
5. **On regression: restore from backup first, diagnose second.**
6. Before declaring a regression, confirm it is apples-to-apples (same filters, same data).

### Restart procedure
NSSM is the **only** supervisor — pm2, the WSL boot task and the `.bat` task were retired
2026-09-14. Route changes: `Restart-Service agi-glass`. Logs: `logs\stdout.log` /
`stderr.log`, NSSM-rotated at 10 MB.
If it wedges: `Stop-Service agi-glass -Force` → `Get-NetTCPConnection -LocalPort 3000,3444
-State Listen` → `taskkill /F /PID <pid>` from an elevated shell (`Stop-Process` fails
silently on the SYSTEM-owned node; a **blank StartTime** in `Get-Process` is that process)
→ `Start-Service agi-glass`. Also confirm `netsh interface portproxy show all` is empty — a
dead boot script once installed proxies on 3000/3444 that fought node for the port.

Healthy = `[DB] SQLite ready: C:\AGI\agi-server\agi-glass.db` freshly appended to
`stdout.log`, listeners owned by `node.exe` with StartTime = now, and `/api/health` →
`"db":"connected"`. Boot takes seconds (migrations run at startup) — wait ~8 s first.

## 4. Data protection (hard rules)

- **Never alter customer, order, tracking, delivery or stock data while coding.** Data fixes
  are their own task: show the rows, get confirmation, back up, use a transaction, stamp
  manual inserts `added_by_name='Admin (manual add)'`.
- **Don't change the past** — saved optimizations, finalised deliveries, printed labels and
  historical records stay as they are; new logic applies to new work.
- Never trigger physical prints during tests. Never save optimizer results while diagnosing.

## 5. Landmines

**Timezone split — the database mixes conventions.** UTC: `orders.created_at`,
`scan_log.ts`, `label_items`, `opt_files`, `slot_inventory`, `deliveries`. Local (UTC+3):
`audit_log.ts`, `attendance.*`, `raw_sheet_transactions`, `worker_salary_history`.
Comparing across the two without normalising is off by 3 hours.

**String comparison on timestamps.** Stored form is `YYYY-MM-DD HH:MM:SS` (space); ISO input
with `T` silently drops rows because `' ' < 'T'`. It had broken **ten query sites** across
reports, labels and remnants — entire days vanished. Normalise at every date parameter.

**`new Date('YYYY-MM-DD')` parses as UTC** — inside a local-time loop it skips days, and it
also bites month-bucket keys built with `toISOString()`. Build dates from local parts, and
when you find one instance **grep for its twins**.

**Base64 in the database.** Attachments and worker photos are base64 columns; `SELECT o.*`
on a list shipped **62 MB per page load**. Exclude heavy columns from lists, fetch the full
record on open, and **grep every consumer before slimming a list** — missed three times,
breaking attachments, cutting-file opening and the optimizer file list.

**Sheet cutting movements are bookkeeping, not production** — recorded in the office later,
in batches. Never read `cutting_movements.movement_date` as a machine timestamp; piece scans
are the truth, minus their batch-scan bursts.

**`workers.email` is a username.** The login route calls it email; the label is a known lie,
deliberately left alone.

**Modals.** `.mbg` has no z-index (DOM order decides stacking; `mbg-top` for nested), and
optional fields must reset on open **and** write on restore or values leak between records.

**Content filter (Chrome extension).** Source dumps, `fn.toString()` and base64 are blocked
and results truncate at ~1,400 chars; work in-page and return counts and booleans.
`confirm()`/`prompt()` wedge extension tabs.

**Express:** specific routes before `:param` routes.
- **snake_case ↔ camelCase drift** is the dominant bug class — it fails as a silent
  `undefined` or empty array, never an error. Read both spellings, or normalise at the route
  boundary.
- **A route can be committed and still 404 because it was never mounted** (`slots`,
  `gsheets`, `translations` each did — the Arabic UI ran in English for weeks). Check
  `app.use` in the *deployed* `server.js` **first**, before route order and port ownership:
  `{"error":"No token"}` = mounted, `Not found: /api/x` = not.
- **Duplicated logic drifts and costs money** — `GET /payroll` (~hr.js L713) and
  `close-month` (~L1123) each carry payroll maths and diverged, freezing wrong nets.
- **Non-ASCII in a QR payload silently blanks the code** (Arabic in notes, sheet label or
  remnant pattern; a raw LF in TSPL) — the encoder throws an overflow a `catch` swallows, and
  one failure once blanked a whole batch. ASCII payloads; Arabic on the visible label only.
- **Serial generators use MAX(suffix)+1, never COUNT+1** — one deletion re-issues a live
  serial. It has hit the delivery serial and the delivery piece code.
- **Never "edit" by delete-then-recreate** — the recreate hits a type whitelist, 400s
  unchecked, and the delete has already committed. `PUT /transactions/:txId` edits in place.
- **`-Encoding ascii` destroys Arabic and em dashes** — a probe on `'%فضل%'` returned nothing
  and read as "no such data". PowerShell 5.1 also *reads* UTF-8 as ANSI by default.

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
  month before applying raises.** A closed month **returns its snapshot and returns early** —
  new calculation code never runs for it, which looks exactly like "the fix didn't deploy".
- **Glass identity is five parts**: thickness + type + family + colour + pattern. The old
  three-part key let a fluted piece load onto a plain sheet via `addOrderToCutQueue`, the gate
  deciding what reaches the saw. `fluted` is a pattern, `antique` a family, neither a colour.
- **Payroll is monthly-fixed** over a notional 240 h (30 d × 8 h), so month length is
  irrelevant. **Every** weekend/holiday hour is ×1.5 (those days create no OT record);
  normal-day OT is ×1.25, approved only. SS is on the registered base, not gross.
- **Select the payroll population by money** — `is_active=1 AND (monthly_salary>0 OR
  hourly_rate>0)`. By `role` or `monthly_salary` alone it returned zero real workers and
  included non-person profiles, which must fall out naturally, never be deactivated.
- **فضل sheets are virtual** — no physical stock, legitimately negative, excluded from sheet
  counts, runout and dashboard metrics. Some are referenced by real opt files: never delete.

## 7. Conventions

- Every UI change includes Arabic handling (`data-i18n` + translation entries).
- Commit at session end or after each verified feature, with a descriptive multi-line
  message explaining *why*, not just what.
- Temp scripts use a `_` prefix and are gitignored.

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
- **Month-lock**: Close Month snapshots but still accepts attendance/leave/OT/adjustment
  writes for that month, so the freeze is weaker than its stated purpose.
- **Off-machine backup copy and one rehearsed restore** — the snapshot folder shares a disk
  with the database and a restore has never been practised.
- Optimizer: layouts are not reliably guillotine-cuttable, rotation is immediate-best-fit,
  and the consolidation pass still lacks strip alignment.

## 9. Reference documents

**`C:\AGI\docs\`** — distilled from the 2026 session history, and where new detail belongs so
this file stays short: `landmines.md` (the mechanism behind every repeat bug), `decisions.md`
(why it is built this way, including what was abandoned), `domain-rules.md`, `modules.md`
(files, routes, real column names), `history-timeline.md`. In project knowledge:
`HR-PAYROLL-SPECIFICATION.md`, `PRICING-FINAL-DATA-MODEL.md`, `PRICING-SYSTEM-REDESIGN.md`,
`PRODUCTION-PLANNING-DESIGN.md`, `SQL-MIGRATION-PLAN.md`, `AGI-ERP-PROJECT-CONTEXT.md`.

## 10. How Ala works

Direct and decisive — expects a clear yes/no on each proposed change, prefers investigation
over speculation, says "ignore" to close a thread. **State the plan and wait for confirmation
before writing code**, and fix only what was reported. Getting something wrong is fine;
guessing and presenting it as fact is not. Flag risks *before* running something destructive,
say when a fix is a workaround, and when a measurement contradicts an assumption the
measurement wins — several of this system's worst bugs were found that way.
