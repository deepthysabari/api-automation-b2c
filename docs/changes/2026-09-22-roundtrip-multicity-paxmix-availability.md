# Availability coverage: roundtrip, multicity, passenger mixes

**Date:** 2026-09-22 · **Author:** Deepthy (with Claude)

## What was added

Following on from the oneway availability work (2026-09-21), filled out the remaining
availability dimensions the user asked for — trip types and passenger mixes — each as its own
feature file, mirroring the existing Shape A (random-sector marketplace) convention:

- `features/common/01_availability/domestic/roundtrip.feature` and
  `.../international/roundtrip.feature` — same shape as `oneway.feature`, `RT` instead of `OW`.
- `features/common/01_availability/multicity/multicity.feature` — domestic only.
  `sectorResolutionEngine.js`'s dynamic 2-leg stitching (already built, unused until now) reuses
  `config/sectorPools/domestic.json` directly, no new route data needed. **International
  multicity is not covered** — no `multicity_int` sector pool exists, and no international MC
  routes were given to verify against; would need dedicated data before building.
- `features/common/01_availability/domestic/oneway_mixes.feature` and
  `.../international/oneway_mixes.feature` — `Scenario Outline` varying `passenger mix` across
  `2 ADT`, `1 ADT + 1 CHD`, `1 ADT + 1 CHD + 1 INF` (the 3 non-trivial combos in
  `config/matrix/paxMix.json`), same random-sector marketplace search as oneway.feature.

All three verified live before committing (separately, via hand-built scenario objects against
the real engine): domestic RT (DEL-BOM, 530+ journeys), international RT (initially returned an
empty result on one date pair — retried on a different date and got 2 real Trips arrays;
consistent with the already-documented "thin, route-dependent" beta inventory, not a defect),
domestic MC (DEL-BOM-DEL dynamic stitch, 743/768 journeys per leg), and all 3 pax mixes on both
DEL-BOM and BOM-DXB (500-970+ journeys each).

## A real blocker found, not yet resolved: cabin class

The user also asked for a cabin-class feature file (Economy/Premium Economy/Business/First).
Live-tested before building anything:

- `configs/airlines.json` doesn't declare `PE` (Premium Economy) or `F` (First) as a supported
  cabin for **any** registered carrier — only `B` (Business) is declared, by `6E, AI, EK, EY,
  WY` and several GDS-only internationals.
- `config/config.js` has no `premiumSupportedRoutes` at all (CLAUDE.md's Phase 0 note already
  flagged this as dropped) — `sectorResolutionEngine.js`'s cabin-`B` route filter
  (`config.premiumSupportedRoutes || []`) is therefore always empty, so **any** Business-cabin
  scenario using the sector pool throws `No eligible routes found` immediately. Confirmed live.
- Even bypassing the pool with an explicit preferred `AI` search on `DEL-BOM` requesting
  `OnwardCabin: "B"` directly: 563 journeys returned, **all** Economy (`Cabin: "E"`, economy
  fare-basis codes like `SU1YXF2I`). Same result for `PE`/`F` on the same route, and on
  `BOM-DXB` all three cabin requests (`B`/`PE`/`F`) returned an empty Trips result entirely.

No live evidence so far that B2C's beta returns genuine non-Economy inventory through this
endpoint, on the routes/dates tried. Could mean the `OnwardCabin` filter is non-functional
(similar to the confirmed-non-functional `Parameters.Airlines` filter from the 2026-09-21
session), or genuinely no premium fare content exists on these particular routes/dates, or both.

**Not resolved yet** — the user is checking the live API directly and will follow up before this
gets built, rather than guessing at which explanation is right or fabricating a passing
assertion CLAUDE.md rule 0 wouldn't allow anyway.

## Verification, and a real bug found along the way

- `node -e ...` hand-built scenario probes for RT (domestic + international), MC (domestic),
  and all 3 pax mixes (domestic + international) — all returned real journeys before any
  feature file was written.
- Full scenario suite (15 scenarios after this session, up from 6) run repeatedly via
  `npx jest tests/scenarios.test.js`. The first two runs surfaced a real bug, not flakiness:
  both the international common-oneway scenario AND the new international roundtrip scenario
  failed the same way — `SB`/`1G` provider missing — both times landing on `IXE-DXB`/`IXE-AUH`.
  Those two routes were marked `category: "low_frequency"` in the 2026-09-21 session specifically
  to keep them out of random marketplace picks (they only carry 2 airlines and no `SB`/`1G`,
  unlike the rest of the pool), but `engine/sectorResolutionEngine.js`'s exclusion rule only
  applied to **single**-carrier low-frequency routes — `IXE-DXB`/`IXE-AUH` have 2 carriers each,
  so they were never actually excluded. **Fixed**: the rule now excludes any
  `category: "low_frequency"` route from marketplace selection regardless of carrier count.
- After the fix: 14/15, then 15/15 on subsequent runs. The one remaining failure was `SB`
  missing on `CCJ-AUH` (140 journeys, the pool's smallest marketplace-eligible route) — 3/3
  standalone re-checks immediately after found `SB` present every time, so treated as ordinary
  live-inventory variance on a thin route, consistent with the project's existing tolerance
  model, not a structural gap like the one above.
- `suites/smoke.json` intentionally left unchanged — `npm run test:scenarios` with no `SUITE`
  filter already runs every scenario including the new ones; smoke stays a fast, deliberately
  narrow subset rather than growing to cover every dimension.

## Still open

- Cabin class — blocked on the user's own live-API check (see above).
- International multicity — no sector pool data, needs dedicated route verification.
- Everything already listed as open in `docs/changes/2026-09-21-phase1-first-feature-file.md`
  (matrix generator capability file, `DOM-DEL` sector clarification, `IXW`/`GP`/`HR`/`G9A`
  registry gaps, `SG`'s international capability flag, `QP`/`AK`/`TZ`/`OD`/`J9` not found on any
  probed sector, `AvlURLTest` `REQUIRED_KEYS` scope, `CreateItinerary`/promo/SSR/SeatLayout).
