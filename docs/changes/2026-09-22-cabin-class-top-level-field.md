# Cabin class: the top-level `Cabin` field, not per-trip `OnwardCabin`

**Date:** 2026-09-22 · **Author:** Deepthy (with Claude)

## The bug

`airlines/base/BaseAirlineAdapter.js` sent cabin class as `Trips[].OnwardCabin`/`ReturnCabin`,
with the top-level `Cabin` field always left empty — a comment claimed this was "verified live",
but that claim was ported from the B2B project and never actually re-checked against B2C.

Live-tested 2026-09-21: requesting `OnwardCabin: "B"` (Business) on `DEL-BOM`, even through a
preferred `AI` search, returned 563 journeys — every one Economy (`Cabin: "E"`, economy
fare-basis codes). Same for Premium Economy/First. Looked like B2C's beta might not sell
non-Economy fares at all through this endpoint.

## The fix

The user captured a real request directly against the live API and shared it. Its shape:
`Cabin: "B"` at the **top level**, and `Trips[]` carrying no cabin field at all
(`{From, To, OnwardDate, ReturnDate, TUI}` only). Reproduced through the real engine pipeline
(patching a live-built ExpressSearch step to match): `COK-BOM`, `Cabin: "B"` top-level →
**140 journeys, every one genuinely `Cabin: "B"`**. Confirmed for all 4 cabin classes:

| Cabin | Route | Result |
|---|---|---|
| E | COK-BOM | 461 journeys, all `E` |
| B | COK-BOM | 140 journeys, all `B` |
| B | DEL-BOM | 204 journeys, all `B` |
| B | BOM-DXB | 0 (genuine — no live Business inventory that route/date, not an error) |
| PE | COK-BOM | 81 journeys, all `PE` |
| PE | DEL-BOM | 309 journeys, all `PE` |
| PE | BOM-DXB | 76 journeys, all `PE` |
| F | DEL-BOM | 3 journeys, all `F` |
| F | BOM-DXB | 29 journeys, all `F` |
| F | COK-BOM | 0 (genuine) |

All 4 cabin classes work — including Premium Economy and First, despite no carrier declaring
support for either in `configs/airlines.json` (that registry's capability flags remain
B2B-sourced and unverified per the 2026-09-18 session's own caveat; this is more evidence they
need a dedicated pass, not fixed here).

**Fix**: `buildTrips()` no longer sets `OnwardCabin`/`ReturnCabin` on any `Trips[]` entry (OW,
RT, MC). Every `ExpressSearch` body-construction site (main flow, both domestic-multicity
per-leg flows) now sets the top-level `Cabin` field to `cabinClass || this.config.defaultCabinClass`
instead of `''`. This is a platform-wide B2C/B2B difference (CLAUDE.md rule 1 — not a carrier
quirk), same reasoning as the JourneyKey-format and preferred-search fixes from 2026-09-21.

## Verification

- Reproduced live for all 4 cabin classes on 3 different routes (table above), through the real
  engine pipeline, before touching any code.
- After the fix: full 15-scenario suite (all still Economy-only scenarios) re-run to confirm no
  regression — cabin class defaults to `E` unchanged for every existing scenario.

## Follow-up: feature files, `premiumSupportedRoutes`, and a polling race found under load

- **`config/config.js`**: `premiumSupportedRoutes` had been empty since Phase 0 (dropped,
  unverified for B2C) — `sectorResolutionEngine.js`'s `cabinClass === 'B'` route filter reads
  it, so with it empty, **every** Business-cabin scenario using the sector pool threw
  `No eligible routes found` immediately, regardless of live reality. Batch-verified all 12
  routes across both sector pools genuinely carry Business inventory (17-304 journeys each,
  every one Cabin:"B") and populated the list with all of them.
- **`ow_cabinclass.feature`** (domestic + international): `Scenario Outline` over all 4 cabin
  classes, mirroring the oneway.feature convention.
- **A real polling race, found while verifying the full suite under load**: `engine/executor.js`
  `_pollSearch()` trusted `GetExpSearch`'s first `Completed: "True"` signal immediately. Under
  Jest's concurrent execution (now 23 scenarios), searches occasionally came back missing a GDS
  provider (`SB`) from an otherwise rich, near-complete result — never reproducible in a serial/
  standalone check on the exact same route/date (5/5 direct re-checks on the affected route,
  `CCJ-DXB`, found `SB` present every time with 290-291 journeys) — i.e. genuinely a completion-
  timing race, not a live-inventory or route-quality issue. **Fixed**: now requires two
  *consecutive* `Completed: "True"` polls before trusting the result; a non-completed poll
  after a `True` resets the counter rather than treating the earlier `True` as confirmed. The
  existing union-only journey aggregation makes the extra confirmatory poll safe (never
  regresses, only fills gaps) at the cost of one extra ~1.5s round trip on the common case.
  Also bumped `@retries:2` (from `1`) on the four international marketplace scenarios that share
  this exposure (`oneway`, `roundtrip`, `oneway_mixes`, `ow_cabinclass`).
- **Result**: before the polling fix, the international common-oneway scenario failed roughly
  2 of every 3 full-suite runs under concurrent load. After: 3 of 4 runs fully green, 1 with a
  single failure of the same class. Not fully eliminated — this is live async-timing noise under
  load that no client-side fix removes entirely — but a real, substantial improvement, and not
  worth chasing further (diminishing returns against a live third-party dependency).

## Still open

- `configs/airlines.json`'s `cabins` capability flags don't declare `PE`/`F` for any carrier
  despite live evidence both work — worth a dedicated pass, not done here.
- Roundtrip × pax-mix and roundtrip × cabin-class combinations aren't covered — only the
  oneway versions of pax-mix/cabin-class exist so far.
