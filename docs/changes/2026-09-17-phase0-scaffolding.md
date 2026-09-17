# Phase 0 — repo scaffolding from api-automation-node

**Date:** 2026-09-17 · **Author:** Deepthy (with Claude)

## What was built

Bootstrapped `api-automation-b2c` from the B2B project (`api-automation-node`), per the
approved [B2C Automation Proposal](../../README.md). Ported the carrier-agnostic engine layer
unchanged, adapted the config/credential layer for B2C's simpler auth model, and rebranded the
dashboard.

**Ported as-is:** `engine/`, `scenarios/` (registry, filter, generator, matrixGenerator,
bddInterpreter), `utils/`, `server/`, `ui/`, `validators/` (generic ones), `airlines/base/` +
`airlines/registry.js` (auto-discovery infra only — no B2B carrier adapters).

**Adapted:**
- `config/environmentStore.js` — B2C's `KEYS` is just `BASE_URL/UtilsURLTest/FlightURLTest/
  AvlURLTest/MerchantID/ApiKey`, vs. B2B's 10-key agent-credential set. No Password/AgentCode/
  BrowserKey/SignatureClientID — B2C's Signature call genuinely doesn't need them.
- `server/index.js`'s `/api/settings/:env/test` — Signature test payload is now just
  `{ MerchantID, ApiKey }`.
- `ui/index.html`'s `SETTINGS_LABELS` — same simplification, plus an `AvlURLTest` field for the
  third subdomain (`ExpressSearch` lives on a separate host from the rest of the Flight API).
- `validators/registry.js` — dropped the hardcoded `airlines/6E/validators` and
  `airlines/SG/validators` requires (no B2C airline-specific validators exist yet).
- `config/config.js` — dropped B2B's hardcoded `premiumSupportedRoutes` (6E-specific Cabin B
  route list, not verified for B2C); kept the `clientAppHeaderName`/`clientAppHeaderValue`
  mechanism (generic, and the B2C API team has separately agreed to a custom identifying
  header, same as B2B's).

**New, empty starters (populate during later phases, not fabricated):**
- `configs/airlines.json` — `{ "LCC": {}, "GDS": {}, "NDC": {} }`, no B2C carriers registered yet.
- `config/sectorPools/{domestic,international}.json` — empty `routes: []`.
- `config/matrix/airlines.json` — `{}`; `config/matrix/executionProfiles.json` — all profiles
  present (smoke/sanity/regression/nightly) with every dimension emptied out, so the dynamic
  matrix generator boots without crashing but produces zero scenarios until real B2C fare-family
  data is confirmed live. `tripTypes.json`/`paxMix.json`/`ssr.json`/`fareFamilies.json` ported
  as-is (universal booking concepts, not B2B-specific).
- `templates/signature_request.json` — the one template built from a *real* captured payload
  (the B2C Postman collection's "Generate Signature" request), since Phase 1's first step is
  verifying this live. The rest of `templates/` is intentionally empty — building request
  templates for ExpressSearch/SmartPricer/etc. without live verification would be exactly the
  kind of fabrication this project's live-only rule exists to prevent.

**Dropped, not ported:** `converter/` (legacy Postman→JSON tool, tied to the pre-Gherkin
`testData/*.json` era), `tests/dataDriven.test.js` and its `npm test`/`convert`/`convert:test`
scripts, `test:6E`/`test:AIRLINE`-style hardcoded scripts (no B2C airline to hardcode yet).

## Verification

- `npm install` — 493 packages, clean.
- `node -e "require('./engine/executor')"` etc. — every ported module resolves with no missing
  dependencies once `npm install` ran.
- `npx jest tests/scenarios.test.js` — full pipeline (registry → matrix generator → filter →
  reporter) boots end-to-end and correctly reports "No scenarios matched" (expected — zero
  feature files, zero matrix dimensions configured).
- `node server/index.js` — dashboard boots clean on port 3099, no missing-module or config
  errors.

## Explicitly not done in this phase

No live API calls were made. No B2C credentials beyond the shared Beta `MerchantID`/`ApiKey`
(from the team's Postman environment) exist anywhere in this repo. No feature files, no airline
adapters beyond the generic fallback, no request templates beyond Signature. That's Phase 1:
verify Signature → ExpressSearch → GetExpSearch → SmartPricer → GetSPricer against the live B2C
beta API, one stage at a time — same discipline the B2B project used throughout.
