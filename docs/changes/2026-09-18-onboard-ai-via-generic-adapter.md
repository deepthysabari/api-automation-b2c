# Onboarding AI (Air India) via config + generic-adapter fixes, not a bespoke adapter.js

**Date:** 2026-09-18 · **Author:** Deepthy (with Claude)

## What was done

Picked up Phase 1's "still open" item — wiring the hand-verified templates into the engine's
actual adapter/flow-step mechanism — without violating the project rule against building an
`airlines/<CODE>/adapter.js` before a B2C-specific carrier quirk is found (`CLAUDE.md`,
`airlines/registry.js`). No B2C-specific quirk for AI has been found; everything below is
config plus fixes to the shared `BaseAirlineAdapter`, not carrier-specific code.

**`configs/airlines.json`** — was `{ "LCC": {}, "GDS": {}, "NDC": {} }` (empty since Phase 0).
Ported the full registry from the B2B project (`../api test engine/configs/airlines.json`):
42 LCC-bucket carriers (incl. `AI`), 13 GDS providers, 2 NDC providers. Two caveats recorded
directly in the file:
- A top-level `_provenance` note: the carrier/provider *codes, names, and GDS/NDC/parent
  groupings* are reused as-is (industry metadata), but the *capability flags*
  (`supportsSSR`, `supportsPaidSSR`, `IsLcc`, `cabins`, etc.) were verified against the B2B
  API, not B2C — same reasoning Phase 0 used to drop `premiumSupportedRoutes`. Treat them as
  starting defaults, confirm per airline as real scenarios get built against them.
- A new `TSO` stub in the GDS bucket. It does not exist anywhere in the B2B registry at all —
  confirms it's genuinely new to B2C, not a copy-paste gap. Carries the `Code 1601 "No Record
  found"` pricing-gap finding from
  [2026-09-17-phase1-core-flow-live-verification.md](2026-09-17-phase1-core-flow-live-verification.md)
  directly on the entry, with `airlines: []`/capability unconfirmed.

**Two real porting bugs found and fixed while resolving `AI` through the registry and calling
`getFlowSteps()`** (both are B2C-platform-wide bugs, not carrier quirks):

1. `airlines/base/BaseAirlineAdapter.js`'s `loadTemplate()` fell back to a hardcoded B2B
   `templates/6E/` folder when no `templates/<CODE>/` folder exists for a carrier. B2C has no
   per-carrier template folders at all — Phase 1 built flat `templates/*.json` shared by every
   carrier. Fallback now points at `templates/<name>.json` directly. A carrier-specific override
   folder (`templates/<CODE>/<name>.json`) is still checked first and still works if one is ever
   added — same onboarding path as B2B.
2. Every `ExpressSearch` URL in `getFlowSteps()` was built from `flightUrl`
   (`FlightURLTest`) — correct for B2B's single-subdomain model, wrong for B2C. Phase 1 already
   proved live that `ExpressSearch` lives on the separate `AvlURLTest` subdomain
   (`CLAUDE.md`'s "three API subdomains, not one"). Added `avlUrl` to `getBaseUrls()`
   (falls back to `flightUrl` if a config has no `avlUrlEnvKey`, so this can't break a config
   that predates the split) and repointed all four `ExpressSearch` URL sites at it.

**`airlines/registry.js`** — added `avlUrlEnvKey: 'AvlURLTest'` to `B2B_DEFAULTS` so the
generic synthesized adapter picks up the fix above automatically for every carrier, not just AI.

## Verification

- `registry.resolve('AI')` — still returns the generic synthesized adapter (no
  `airlines/AI/adapter.js` was created), now carrying `GDS` type, `DOM`/`INT` sectors,
  `OW`/`RT`/`MC` trip types, sourced from the newly-populated `configs/airlines.json`.
- `adapter.getFlowSteps(scenario)` for a DEL→BOM one-way — inspected the generated request
  objects directly: `Signature` → `UtilsURLTest`, `ExpressSearch` → `AvlURLTest`,
  `GetExpSearch`/`SmartPricer`/`GetSPricer` → `FlightURLTest`. Exactly the three-subdomain split
  and payload shapes (`FareType: "ON"`, `OnwardDate: "YYYY-MM-DD"`, `OnwardCabin`) Phase 1
  verified live by hand.
- **Ran the real engine live**, not a hand-written script: `executor.execute()` for each of the
  first 5 flow steps, threading context exactly as `Runner` does. `Signature` → `ExpressSearch`
  → `GetExpSearch` → `SmartPricer` all returned `Code 200` against the live beta API (found a
  live `QP` fare, DEL→BOM, 2026-09-25, ₹6,530). `GetSPricer` correctly emitted the engine's
  designed `SKIPPED` outcome after exhausting its 10-attempt poll budget (`Code 501 "No Data
  Found"` never resolved for that fare in time) — a live business outcome, not a defect.

## Explicitly not done in this session

- No `airlines/AI/adapter.js` (or any carrier-specific adapter) was created — no B2C-specific
  quirk has been found for AI yet.
- No feature files, no scenario definitions, no sector pool data populated — `getFlowSteps()`
  was driven directly with a hand-built scenario object for verification, same as Phase 1's
  approach, not through the BDD/matrix pipeline.
- Could not re-confirm the `TSO`/`Code 1601` pricing gap live in this session (see prior
  conversation) — beta inventory for that provider wasn't present on the routes/dates tried;
  the `TSO` registry stub reflects the original Phase 1 finding, not a fresh reproduction.
- The `configs/airlines.json` capability flags remain B2B-sourced and unverified for B2C —
  worth a dedicated pass once real scenarios start exercising specific carriers/sectors.
