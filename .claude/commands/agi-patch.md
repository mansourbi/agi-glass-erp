---
description: Apply a code change using the anchored-patch protocol (backup, count guard, syntax gate)
---

Apply a change to a live file using the anchored patch protocol. This exists
because hand-editing `glassfab.html` (~26k lines) and the route files has
broken production before. **Follow every step; do not shortcut.**

$ARGUMENTS

## Before writing anything

1. **Diagnose read-only first.** Show the exact current code or rows. Never
   guess at data — investigate, then propose.
2. State the plan and **wait for Ala's yes** before writing code.
3. Fix only what was reported. No opportunistic edits.

## The patch

4. **Timestamped backup first** — `_public_backups\` or `_route_backups\`,
   named `name.TIMESTAMP.TAG`.
5. Write a temp Node script (`_` prefix, gitignored) via a PowerShell
   here-string. Do not hand-edit the target file.
6. **Compute every anchor from the live file. Never transcribe one by eye** —
   six consecutive aborts in one session came from transcribed anchors.
7. Check anchors for mutual substring overlap.
8. Add an **idempotency guard** at the top — re-running must be a no-op.
9. Use `rep(name, oldExact, new)` with a **count guard that aborts the entire
   write if any anchor does not match exactly once.** Partial writes are worse
   than no write.

## After

10. `node --check` the result, and gate the restart on its exit code *and* on
    the patched file existing and being non-empty.
11. Routes need `Restart-Service agi-glass`; HTML needs only a hard refresh.
12. **Verify on the live screen.** Passing anchor counts is not proof.
13. On regression: **restore from backup first, diagnose second.** Before
    calling it a regression, confirm it is apples-to-apples — same filters,
    same data.

## Hard limits

- Never alter customer, order, tracking, delivery or stock data as part of a
  code change. Data fixes are their own task.
- Never trigger a physical print. Never save optimizer results while diagnosing.
- Don't change the past — saved optimizations, finalised deliveries, printed
  labels stay as they are.
- Every UI change includes Arabic handling (`data-i18n` + translation entries).
