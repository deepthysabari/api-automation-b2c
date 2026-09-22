# International multicity: a broken DSL step fixed, 3 of 4 given routes confirmed

**Date:** 2026-09-22 · **Author:** Deepthy (with Claude)

## The bug

The user gave 4 international multicity itineraries (`BLR-AUH-AMS`, `ZRH-AUH-BLR`,
`COK-DXB-DOH`, `COK-DXB-LHR-ZGG`) to verify and build. Live-testing them immediately surfaced a
real, pre-existing bug in `scenarios/bddInterpreter.js`'s `"search for multicity sectors "X-Y,
Y-Z""` step (the explicit/hardcoded-sector DSL, distinct from the dynamic-stitch
`"search for domestic multicity flight"` step, which was unaffected):

- Every scenario's `dataset` starts with `sectorPool: 'domestic'` by default at creation time.
  The multicity-sectors step parsed the sectors the user typed into `dataset.sectors`, but never
  cleared that leftover default `sectorPool`.
- `engine/sectorResolutionEngine.js` has a dedicated bypass for exactly this case ("if explicit
  sectors exist, use them directly"), but it only fires when `dataset.sectorPool` is falsy.
  With the default still set, the bypass never triggered.
- Result: a domestic-classified chain (e.g. any chain not touching the 3 hardcoded hub codes
  the classifier checked) got silently overwritten — `_stitchDynamicMulticity` picked its own
  random 2-leg route from the domestic pool instead, discarding the typed sectors entirely with
  no error. An international-classified chain threw immediately, looking for a `multicity_int`
  sector pool that has never existed in this project.
- Separately, the DOM/INT classification itself only checked for `DXB`/`LHR`/`AMS` in the
  chain — `ZRH-AUH-BLR` touches none of those and would have been misclassified as domestic.

**Fixed**: the step now explicitly `delete`s `dataset.sectorPool` (not just avoids setting it),
letting the existing hardcoded-sectors bypass work as designed. Classification now checks every
leg's origin/destination against a known-Indian-domestic-airport list, not 3 arbitrary hub codes.

## The given routes

First read as two separate 2-leg itineraries (`BLR-AUH-AMS`, `ZRH-AUH-BLR`) plus `COK-DXB-DOH`
and `COK-DXB-LHR-ZGG`. The user then clarified `BLR-AUH-AMS` and `ZRH-AUH-BLR` were actually
meant as ONE combined 4-leg itinerary (`BLR→AUH→AMS`, then separately `ZRH→AUH→BLR` — the legs
don't connect end-to-end, an open-jaw-style complex trip, not a continuous chain), matching what
they were seeing directly in the live API themselves. Live-verified via the real engine
(hand-built scenario + `adapter.getFlowSteps()`) before writing any feature file:

| Route | Result |
|---|---|
| `BLR-AUH, AUH-AMS, ZRH-AUH, AUH-BLR` (combined 4-leg) | 170 journeys/leg |
| `COK-DXB-DOH` | 470 journeys/leg |
| `COK-DXB-LHR-ZGG` | Empty, on two different date sets |

The 3rd is a genuine open question, not dropped as broken: every individual 2-leg segment
(`COK-DXB`, `DXB-LHR`, `LHR-ZGG` — even `LHR-ZGG`/`DXB-ZGG`/`DEL-ZGG` round trips, 199–766
journeys each) returns real inventory when tested alone. `ZGG` itself is a genuine, servable
code — the failure is specific to the full 3-leg chain. Could be a real "no combinable 3-leg
fare for this exact routing" business fact, or a limit on how many legs this API's international
multicity actually supports. **User's call: set aside for now, not investigated further.**

Built the 2 confirmed routes into
`features/common/01_availability/multicity/multicity_international.feature`, one scenario each,
using the now-fixed explicit-sectors step — proving it correctly handles both a 2-leg and a
4-leg chain.

## Verification

- Each route hand-verified live via the real engine before being written into a feature file.
- Full scenario suite (25 scenarios, up from 23) run via `npx jest tests/scenarios.test.js`
  after the fix and after the 4-leg correction — fully green (25/25).

## Still open

- `COK-DXB-LHR-ZGG` (3-leg) — set aside per the user's decision, not investigated further for
  now.
- Everything already listed as open in the 2026-09-21/2026-09-22 change docs.
