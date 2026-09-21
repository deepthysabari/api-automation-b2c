# Phase 1 — first runnable feature file, and a real JourneyKey parsing bug found live

**Date:** 2026-09-21 · **Author:** Deepthy (with Claude)

## What was blocking every run

Before this session, `scenarioEngine.load()` returned 0 test cases for every `npm run test:*` /
`run:*` command — confirmed by running it directly. Two empty data sources, both pure
configuration gaps, not code bugs:

- `features/` had no `.feature` files at all (`scenarios/registry.js`'s BDD loader had nothing
  to parse).
- `config/sectorPools/domestic.json` / `international.json` both had `routes: []`.

Note: this is a **different** file from `configs/airlines.json` (the registry populated in the
2026-09-18 session) — `config/matrix/airlines.json` (capability matrix for the *dynamic
matrix generator*, a separate scenario-generation path from BDD) is still `{}` and stays that
way; out of scope for this session, which only needed the BDD path to produce a scenario.

## What was done

- **`config/sectorPools/domestic.json`**: added the DEL→BOM route, the only one with a live
  verification trail so far (Phase 1's AI fare, and the 2026-09-18 session's QP fare), tagged
  with `airlines: ["AI", "QP"]` and an inline `_verifiedLive` note per carrier. No other routes
  added — CLAUDE.md rule 0 (live-only, no fabricated data) applies to sector pool entries just
  as much as to responses.
- **`features/common/01_availability/domestic/oneway.feature`**: this project's first feature
  file. Two scenarios (AI, QP), both domestic oneway, both using `pricingOnlyFlow` — stops after
  `GetSPricer`, deliberately not reaching `CreateItinerary` (still B2B-shaped per CLAUDE.md,
  Phase 3 work, not touched here).
- **`suites/smoke.json`**: the `smoke` suite `npm run test:smoke` expects (`scenarios/filter.js`
  `_loadSuite`) didn't exist yet either — `suites/` was empty. Added, listing the two new
  scenario IDs.

## A real bug found running these live, not a data gap

Both scenarios initially failed `segmentValidator` on real live data, not on a scenario-authoring
mistake. Root cause: `airlines/base/BaseValidator.js`'s `_parseJourneyKey()` — ported from B2B
unchanged — assumes B2B's `~`-separated, 9-field-per-leg `JourneyKey` format
(`MAC,FlightNo,From,To,DepartureTime,ArrivalTime,...,Duration`). **B2C's `JourneyKey` format is
completely different**: `DEL-BOM,1745,AI,2026-09-24,E` — route as one `"XXX-YYY"` field, then
FlightNo, airline code, date, cabin. Confirmed live for both a direct AI journey
(`DEL-BOM,1745,AI,2026-09-24,E`) and a real connecting one
(`DEL-IXC,1743,AI,2026-09-24,E~IXC-BOM,472,AI,2026-09-24,E`, via provider `SB`, DEL→IXC→BOM).

Reading B2C's fields at B2B's positions doesn't throw — it silently produces a plausible-looking
but wrong parse (`From: "AI"` the airline code, `To: "2026-09-24"` the date), which then failed
segment-level origin/destination assertions on **every** journey in the response.

Worse for connecting itineraries specifically: B2C's own `Connections` array entries carry no
`FlightNo` at all (only `Airport`/`Duration`/`Type`), so once the JourneyKey mis-parse was fixed
by rejecting it outright, `_segmentsOf` fell through to the `Connections` branch and surfaced a
second, more specific bug — `Segment[1] missing FlightNo` — because B2C's `JourneyKey` is
actually the *only* place a connecting leg's real per-leg `FlightNo`/`From`/`To` exists at all.

**Fix** (`_parseJourneyKey`, `airlines/base/BaseValidator.js`): detect both formats per leg —
B2C's `"XXX-YYY"` route-as-one-field shape first (regex `^[A-Z]{3}-[A-Z]{3}$` on the first comma
field), falling back to B2B's positional shape otherwise — and keep the existing
"From/To must look like a real IATA code" guard as the safety net that catches anything matching
neither format cleanly. This is a platform-wide B2C/B2B difference, not a carrier quirk, so it
belongs in the shared `BaseValidator.js`, same reasoning the 2026-09-18 session used for the
`AvlURLTest` subdomain fix in `BaseAirlineAdapter.js`.

## Verification

- `npx jest tests/scenarios.test.js` — both scenarios PASSED, live, all 5 steps
  (Signature → ExpressSearch → GetExpSearch → SmartPricer → GetSPricer) through the real engine.
- `npm run test:smoke` — the actual documented entry point — passes the same way.
- Confirmed the fix against three live shapes captured directly from the beta API: a
  direct-flight `JourneyKey`, a real 1-stop connecting `JourneyKey` (DEL→IXC→BOM via `SB`), and
  re-ran full suite after each fix increment to confirm no regression on the already-passing
  scenario.

## Still open

- `config/matrix/airlines.json` (dynamic matrix generator's capability file) is still empty —
  the BDD path proven here is a separate mechanism from that one; populating it is separate work
  if/when dynamic (non-BDD) scenario generation is wanted.
- Only one route (DEL→BOM) in any sector pool. Route selection needs the same
  live-verify-before-adding discipline Phase 1 used — no bulk-porting B2B's route list without
  checking B2C beta inventory per route.
- `AvlURLTest` is not in `environmentStore.js`'s `REQUIRED_KEYS` — noted but not changed this
  session (that list is explicitly scoped to "what Signature needs", not every URL the engine
  uses, so this needs a decision on scope before touching it, not a same-session fix).
- `CreateItinerary`, promo flow, SSR/SeatLayout scenarios — still not started (Phases 2–3, per
  CLAUDE.md).
