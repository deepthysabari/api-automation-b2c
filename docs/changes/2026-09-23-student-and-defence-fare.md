# Student fare, defence fare, and a concurrency fix

**Date:** 2026-09-23 · **Author:** Deepthy (with Claude)

## Student fare — confirmed, built (domestic only)

The user gave the real codes directly: `PaxCategory: "STU"` for student, `"DEF"` for defence.

`STU` confirmed live: 19/492 journeys on `COK-BLR` came back tagged `PaxCategory: "STU"`.
Verified through the real BDD pipeline (`parseFile` → `build` → `runner.runTestCase`), not just
a hand probe, before writing the feature file.

International: tried `BOM-DXB` and `COK-DXB` — both returned a **fully empty** result (not just
untagged; the whole search came back with zero journeys). Different failure shape than senior
citizen's international attempt (which returned hundreds of journeys, just none tagged `SCP`).
Read as domestic-only, same as senior citizen; not built for international.

Built `domestic/ow_studentfare.feature`.

## Defence fare — mechanism wired, not built yet (no live-tagged inventory found)

`DEF` is wired identically (same `PaxCategory` mechanism, confirmed working for `SCP`/`STU`),
but found **zero tagged journeys across 6 samples**: 5 domestic marketplace searches
(`DEL-BLR`, `COK-BLR`, `MAA-DEL`, `BOM-ATQ`, plus an empty `DEL-BOM`) and 1 preferred `AI` search
(`COK-BLR`) — two of the six returned a fully empty result, the rest returned real journeys
(134–404) with none tagged `DEF`.

**Not built** — a scenario asserting "at least one bookable defence fare exists" would be
permanently red with the evidence in hand. This isn't necessarily a mechanism problem (the exact
same approach works for `SCP`/`STU`); more likely defence fares are genuinely rarer/more
route-or-eligibility-restricted inventory. `defenceFareValidator.js` is written and registered
(`validators/registry.js`), ready to use the moment a route/date is found where `DEF` actually
tags something — same as what unlocked `STU`/`SCP`.

## Refactor: one shared implementation instead of three near-identical files

`seniorCitizenValidator.js`, `studentFareValidator.js`, `defenceFareValidator.js` all share one
real mechanism (a `PaxCategory` code) and one shape (existence check, or a positional check if a
fare was already selected upstream). Extracted the shared logic into
`validators/availability/paxCategoryValidatorFactory.js` — each of the three is now a ~15-line
file that just names its own code/label. `seniorCitizenValidator.js` refactored to match without
changing its registered name or external behavior.

## A recurring concurrency finding: lowered default CONCURRENCY, 3 → 2

The 43-scenario suite (up from 39) reproduced the exact same class of finding from yesterday —
severely truncated results (1 carrier where several are normal) and poll-budget exhaustion before
`Completed` ever flipped `True` — both only ever seen under Jest's concurrent execution, never in
a serial/standalone check on the same route/date. Bumping `maxAttempts` (yesterday's fix, 30→40)
only bought temporary headroom; the same symptom recurred at the next scenario-count milestone,
confirming the actual lever is shared-backend contention under concurrent load, not poll patience.

**Fixed**: lowered the default `CONCURRENCY` from 3 to 2 in `jest.config.js`,
`engine/scenarioEngine.js` (used by `cli/run.js`), and `server/index.js` (the UI's `/api/run`) —
kept consistent across all three, as the existing comments already claimed they were. Verified:
2 consecutive full 43-scenario runs, 86/86 passes.

## Still open

- Defence fare — needs a route/date where it actually tags something, same as what unlocked
  `STU`/`SCP`.
- `S5 183`'s direct-flight leak (from the previous session) — not re-investigated this round.
- Everything already listed as open in the earlier change docs.
