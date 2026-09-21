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
- **`suites/smoke.json`**: the `smoke` suite `npm run test:smoke` expects (`scenarios/filter.js`
  `_loadSuite`) didn't exist yet either — `suites/` was empty. Added.

### First pass at the feature file (superseded, see below)

The first version of `features/common/01_availability/domestic/oneway.feature` used two
airline-specific `pricingOnlyFlow` scenarios (AI, QP), asserting each priced correctly. That's
not this project's actual convention — the B2B project's own `common/01_availability/` tree
(read directly from `../api test engine/` as CLAUDE.md directs) uses **marketplace availability**
scenarios instead: one scenario per sector type, searching all airlines on a known-good route
and asserting which carriers/providers are expected to show up. Deleted and replaced with the
structure below to match.

### Restructured to match the B2B convention

- **`features/common/01_availability/domestic/oneway.feature`** and
  **`features/common/01_availability/international/oneway.feature`**: one marketplace-search
  scenario each, mirroring B2B's own `common/01_availability/{domestic,international}/oneway.feature`
  exactly in shape (`Given user searches all airlines` / `validate airlines "..." are present in
  the response` / `validate provider "..." availability`). Anchored to routes actually confirmed
  live, not ported from B2B's own airline/provider lists:
  - **Domestic**: DEL→BOM (same route as before). Live marketplace search returned airlines
    `6E, AI, IX, IXW, QP, SG` and providers including `1G, AM, BNT, C6E, CSG, ESG, JCL, SB, SG,
    TSO`. `IXW` isn't registered in `configs/airlines.json` at all — not asserted, flagged as a
    gap instead of silently dropped or fabricated.
  - **International**: BOM→DXB, the same anchor route B2B itself uses. Verified live with ~950–
    1030 journeys per search across 8 separate captures over 2 dates.
- **`config/sectorPools/international.json`**: was `routes: []` — added the BOM→DXB entry with
  the same live-verification discipline as the domestic pool.

### A second live finding: real day-to-day inventory variance, not just "thin"

Phase 1's docs already warned inventory is "thin and route-dependent." This session found a more
specific pattern on BOM→DXB, from 8 separate live captures across 2 dates:
- A **stable core** of 11 carriers (`6E, AI, EK, EY, G9, GF, IX, QR, SV, UL, WY`) present in
  every full (non-partial) capture.
- A **volatile fringe** (`ET, FZ, KQ, MS, RJ, TK, XY`) present in some full captures and absent
  in others — confirmed genuine schedule variance, not a bug: one Jest run failed asserting `RJ`
  present (16 carriers returned, just not that one), retried, and missed `RJ` again on the retry
  too, with every other expected carrier present both times.
- Separately, **1 of the 8 captures** returned a single-carrier, near-empty result while the
  other 7 returned the normal ~950–1030 journeys — `GetExpSearch`'s `Completed: "True"` signal
  firing before the async result index is fully populated, a live-API race rather than either of
  the above.

Both are documented directly in the international feature file's comments. The asserted airline
list is deliberately scoped to the stable core only (asserting the volatile fringe would make the
suite flaky for reasons unrelated to the platform under test); `@retries:1` was added to
re-poll past the second, unrelated race.

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

## Third pass: random sector-pool selection + niche single-sector carriers

The user gave the actual business list of domestic carriers/providers to cover (IndiGo,
SpiceJet, Star Air, Air India Express, Akasa, Alliance Air, Fly91, Sabre, FlyWithOS, Amadeus,
Galileo — all already registered in `configs/airlines.json`) plus a list of top domestic
sectors, and asked for two changes: (1) the common domestic scenario should pick its sector **at
random from the pool**, not stay pinned to one hardcoded route, and (2) any airline that only
flies specific sectors needs its own dedicated search scoped to that sector.

**Live-probed all 7 given sectors** (`COK-BLR`, `BLR-PNQ`, `MAA-DEL`, `BOM-ATQ`, `BOM-LKO`,
`DEL-BLR`, `SDW-PNQ`) plus the existing `DEL-BOM`, and found: `9I` (Alliance Air) live on
`COK-BLR`, `S5` (Star Air) live on `BLR-PNQ`, `IC` (Fly91) live — exclusively — on `SDW-PNQ`
(matches Fly91's real-world Sindhudurg network), and `SP1` (FlyWithOS) live on `BOM-LKO`/`DEL-BLR`.
(`DOM-DEL`, given as a possible 8th sector, was never clarified — `DOM` isn't a real IATA code —
so it wasn't added; still open below.)

- **`config/sectorPools/domestic.json`**: rebuilt with 8 routes, each carrying its own
  live-verified `airlines` array (not a copy-pasted list) — `scenarios/generator.js` spreads a
  route's `airlines` straight into the built scenario's `dataset.airlines`, which
  `availabilityValidator` uses to scope "expected airlines present" to only what that specific
  route can support. `SDW-PNQ` is marked `category: "low_frequency"` (IC-only), which
  `sectorResolutionEngine.js` already excludes from marketplace (random) selection — reachable
  only via a preferred `IC` search.
- **`features/common/01_availability/domestic/oneway.feature`**: rewritten as two Shapes,
  mirroring B2B's own `s3_verification/domestic_availability.feature` convention:
  - **Shape A** (common): `search for domestic OW flight` with no explicit origin/destination —
    sector picked at random from the pool. Asserts the full common carrier list; the pool's
    per-route scoping (above) means only carriers that route actually carries get asserted.
  - **Shape B** (niche): one `Scenario Outline` for `9I`/`S5`/`IC`, `Given user selects airline
    "<airline>"` with no explicit route — `sectorResolutionEngine` scopes selection to that
    carrier's own pooled route automatically.

### A third live finding, and a validator behavior fix

The `9I` niche scenario initially failed: a preferred search for `9I` on `COK-BLR` returned 70
journeys, but only 3 were genuinely `9I` — the other 67 were `AI` (Alliance Air is a wholly
state-owned Air India subsidiary). The existing `availabilityValidator` preferred-mode check
failed the *entire scenario* on the first non-matching journey, which meant a real, live-proven
"yes, 9I flies this route" result still failed the test.

Asked the user how to treat this; decided (not assumed): a preferred search should fail only
when the requested carrier is genuinely absent, not when other carriers' journeys leak in
alongside real matches. Implemented as a **general validator policy change**, not a 9I-specific
hardcode (CLAUDE.md rule 1) — `availabilityValidator.js` preferred-mode branch now counts
matches across the whole response and fails only if that count is zero; any non-matching
carriers found alongside at least one real match are reported as a warning instead. This applies
to every carrier in preferred mode, not just `9I`.

## Verification

- `npx jest tests/scenarios.test.js` and `npm run test:smoke` (the actual documented entry
  point) — both pass live, all steps through the real engine.
- Confirmed the JourneyKey fix against three live shapes captured directly from the beta API: a
  direct-flight `JourneyKey`, a real 1-stop connecting `JourneyKey` (DEL→IXC→BOM via `SB`), and
  re-ran the suite after each fix increment to confirm no regression.
- `npm run test:smoke` run **4 times in a row** after settling on the narrower international
  airline list + `@retries:1` — all 4 passed, 2/2 scenarios each time.
- After the third pass (random sector pool + niche scenarios + the preferred-mode validator
  fix): full suite (5 scenarios) run **5 times in a row**, all 5 passing every time, sector pool
  landing on different random routes across runs (confirms the per-route scoping works, not just
  one lucky draw).

## Still open

- `config/matrix/airlines.json` (dynamic matrix generator's capability file) is still empty —
  the BDD path proven here is a separate mechanism from that one; populating it is separate work
  if/when dynamic (non-BDD) scenario generation is wanted.
- `DOM-DEL`, given by the user as a possible 8th domestic sector, was never clarified (`DOM`
  isn't a real IATA code) and isn't in the pool — needs a follow-up answer, not a guess.
- `IXW` (domestic) and `GP`/`HR` (international) were observed live but aren't registered in
  `configs/airlines.json` at all — worth a dedicated look, not fixed here.
- `SG` appeared in a live international marketplace search despite `configs/airlines.json`
  listing `sectorTypes: ["DOM"]` only for it — same unverified-capability-flag caveat the
  2026-09-18 session already recorded, still unresolved.
- `MAA-DEL`'s live marketplace search also returned `SQ`/`SV` (international carriers) on a
  domestic search — likely codeshare/interline leakage, not asserted, worth a dedicated look via
  `airlineLeakageValidator`.
- `AvlURLTest` is not in `environmentStore.js`'s `REQUIRED_KEYS` — noted but not changed this
  session (that list is explicitly scoped to "what Signature needs", not every URL the engine
  uses, so this needs a decision on scope before touching it, not a same-session fix).
- `CreateItinerary`, promo flow, SSR/SeatLayout scenarios — still not started (Phases 2–3, per
  CLAUDE.md).
- International doesn't yet have its own niche-carrier (Shape B) coverage — only domestic does
  so far; the business-given sector list so far was domestic-only.
