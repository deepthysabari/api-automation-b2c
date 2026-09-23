# Direct flight, senior citizen fare: a real request-mechanism fix, student/defence still open

**Date:** 2026-09-23 · **Author:** Deepthy (with Claude)

## What was asked

Feature files/scenarios for 4 dimensions, in the common availability scenario: direct flight,
defence fare, student fare, senior citizen fare.

## Direct flight — built, works as specified

`IsDirect: true` genuinely filters live (confirmed on both domestic and international: 294/525
and 145/145 journeys respectively came back `Stops: 0` when set). Built
`domestic/international ow_directflight.feature`, matching the exact spec given: search any
sector, `IsDirect: true`, confirm every returned journey is `Stops: 0`.

**A real, reproducible imperfection found, not fixed**: the same flight — `S5 183`, `Stops: "1"`
— slipped through the `IsDirect` filter in 2 of 2 domestic runs so far, despite the request
correctly asking for direct-only. The `directFlightValidator` (pre-existing, already strict —
"every returned journey must be `Stops: 0`", matching what was asked) correctly failed both
times. Left the validator as-is rather than loosen it to tolerate this — the ask was explicitly
strict, and this looks like a genuine live-API filtering gap on this specific S5
flight/route, worth reporting to whoever owns the live API, not something to mask in the test.

## Senior citizen fare — a real mechanism fix, same class as the cabin-class one

The user captured a real request directly from the live API and shared it:
`Parameters.PaxCategory: "SCP"`. Before this, the engine sent `Parameters.IsSeniorCitizen: true`
(and `IsStudentFare` similarly) — confirmed live to have **zero effect**: identical journey
count, identical minimum fare, zero senior/student-tagged journeys, whether the flag was true or
false, on a marketplace search AND a preferred `AI` search, same route/date. `PaxCategory: "SCP"`
by contrast genuinely tags journeys — 8–10 out of 72–253 sampled, consistently.

**Fixed across all 4 `ExpressSearch` construction sites** (same platform-wide pattern as the
cabin-class fix): the main OW/RT/international-MC flow, both domestic-multicity per-leg flows,
and — a fifth discovery — the `templates/express_search_request.json` template used by the
`availabilityOnlyFlow` path (the one EVERY BDD feature-file scenario actually uses by default).
That template already had a `"PaxCategory": ""` placeholder sitting there unused since it was
written — hardcoded empty, never wired to a real variable. Now `"PaxCategory": "<<paxCategory>>"`,
substituted from `scenario.dimensions.paxCategory`.

`scenarios/bddInterpreter.js`'s `"senior citizen fare search is enabled"` step now sets
`dimensions.paxCategory = 'SCP'` instead of the dead `isSeniorCitizen` flag.
`validators/availability/seniorCitizenValidator.js` now checks `journey.PaxCategory === 'SCP'`
as the primary signal (keeping the old `IsSeniorCitizen`/`FCType`/`FCGroup` checks as harmless
fallbacks — confirmed live they don't currently vary, but costs nothing to keep checking).

**Domestic only** — tried 3 international routes (`BOM-DXB`, `COK-DXB`, `BOM-AUH`), 0 SCP-tagged
journeys on any of them, despite `COK-BLR` (domestic) reliably returning 10/253. Matches real
Indian aviation policy (senior-citizen discounts are typically domestic-only). Built
`domestic/ow_seniorcitizen.feature` only.

## Student fare and defence fare — still open

- **Student fare**: `IsStudentFare` confirmed dead the same way as `IsSeniorCitizen` was. The
  `"student fare search is enabled"` BDD step is now a documented no-op (comment only) rather
  than silently setting an unused dimension. Needs the same kind of live capture that unlocked
  senior citizen — a real `PaxCategory` code for student fare (or confirmation it's a different
  mechanism entirely). Not guessed at.
- **Defence fare**: no request parameter for it exists anywhere in the codebase, and nothing in
  any live response mentions it. Needs a real captured request/response before anything can be
  built — genuinely unknown mechanism, not assumed to be a `PaxCategory` variant.

## Verification

- Verified `PaxCategory: "SCP"` reaches the live API correctly through the REAL BDD pipeline
  (`bddInterpreter.parseFile()` → `generator.build()` → `runner.runTestCase()`), not just a hand
  probe — this surfaced that hand probes throughout this whole project had been exercising a
  DIFFERENT code path (`pricingOnlyFlow`) than what actual feature-file scenarios use by default
  (`availabilityOnlyFlow`) for the OW/RT/international-MC flow specifically. Confirmed the fix
  applies correctly to the real path before writing any feature file.
- Full 42-scenario suite (up from 39) run via `npx jest tests/scenarios.test.js`: 41/42 passed,
  the 1 failure being the reproducible `S5 183` direct-flight finding above (a real live-API gap,
  not a test defect).

## Still open

- Student fare, defence fare — awaiting a live-captured request/response from the user.
- The `S5 183` direct-flight leak — reproduced 2/2, not investigated further (would need
  confirming whether it's a data-quality issue specific to that flight, or a broader pattern).
- `templates/express_search_request.json`'s `"SecType": "<<secType>>"` placeholder has no
  matching variable passed at its call site — noticed while fixing `PaxCategory` in the same
  object, not fixed (out of scope for this session; unclear what the international value should
  be, only one live-captured domestic example exists: `"SecType": "D"`).
- Everything already listed as open in the earlier change docs.
