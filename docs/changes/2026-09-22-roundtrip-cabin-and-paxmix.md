# Roundtrip × cabin class and roundtrip × pax mix coverage

**Date:** 2026-09-22/23 · **Author:** Deepthy (with Claude)

## What was added

Filled the remaining gap from the earlier oneway-only cabin-class/pax-mix work: roundtrip
versions of both, domestic and international, mirroring the existing Shape A convention exactly
(random-sector marketplace search, dimension varied per row):

- `domestic/roundtrip_mixes.feature`, `international/roundtrip_mixes.feature`
- `domestic/rt_cabinclass.feature`, `international/rt_cabinclass.feature`

All 10 RT+cabin / RT+pax-mix combinations verified live via the real engine (hand-built
scenario + `adapter.getFlowSteps()`) before writing any feature file — e.g. domestic RT
Business: 311 journeys/leg; international RT with 1 ADT+1 CHD+1 INF: 208 journeys.

Suite is now 39 scenarios, up from 25.

## A scaling-pressure finding, not a new bug

First full run at 39 scenarios: 38/39 passed, one `ECONNRESET` (transient network-level drop,
unrelated to the async-completion race fixed the day before). Re-run: 2 failures this time, both
a *different* shape — poll budget exhausted with `Completed` still `"False"` (a genuine
defect-shaped failure per `executor.js`'s own design, not a graceful SKIP).

Root cause: the two-consecutive-`Completed:"True"` confirmation added on 2026-09-22 (to fix the
premature-completion race) costs one extra poll per search. At 39 scenarios' worth of concurrent
load, a couple of slower searches were pushed past the old 30-attempt ceiling. Not seen at 25
scenarios — a genuine capacity/scaling finding, not a logic bug.

**Fix**: bumped `maxAttempts` from 30 to 40 in `engine/executor.js`. Costs nothing on a search
that resolves within the old budget (loop still breaks as soon as it confirms).

## Verification

- All 10 RT+cabin/RT+pax-mix combinations hand-verified live before writing any feature file.
- Full 39-scenario suite run after the `maxAttempts` bump: one complete run, 39/39 passed. A
  second confirmation run was killed mid-flight by the harness's own low-memory protection
  (unrelated to this change — 21/39 scenarios had completed with 0 failures at the point of
  termination, consistent with an interrupted run, not a real failure). Not restarted per the
  harness's own guidance.

## Still open

- Everything already listed as open in the earlier 2026-09-21/2026-09-22 change docs.
- Worth a dedicated look eventually: whether 40 attempts is enough headroom as the suite keeps
  growing, or whether `CONCURRENCY` (default 3) should come down instead of the poll budget going
  up indefinitely.
