# ✈️ api-automation-b2c

Live, scenario-driven test automation for the **B2C airline booking API** — bootstrapped from
[`api-automation-node`](../api%20test%20engine)'s engine (the B2B project), adapted for B2C's
simpler guest-checkout flow.

**Status: Phase 1 availability scenarios done; pricing next.** New here? Start with `ONBOARDING.md`. See `docs/changes/` for the plan and
progress log.

## Live-only, no mocks

Same non-negotiable rule as the B2B project: every scenario hits the **real** B2C beta API.
No mock, stub, fixture, or synthetic-response logic anywhere. A scenario with no live inventory
**SKIPs** — it is never faked. A green result must mean the live API genuinely served it.

## What's ported vs. new

| | |
|---|---|
| **Ported as-is** | `engine/` (executor, runner, TUI-chaining, polling), `scenarios/` (BDD interpreter, filter, generator), `utils/` (HTTP client, reporting), `server/` + `ui/` (dashboard), `airlines/base/` + `airlines/registry.js` (plug-in auto-discovery) |
| **Adapted** | Generic `validators/` (business/availability/pricing/cabinClass); `config/` (B2C's simpler MerchantID+ApiKey credential set, no agent login) |
| **New, built fresh** | `templates/` (B2C payload shapes), `airlines/<CODE>/` adapters, `features/` (Gherkin scenarios), `suites/` |

## Setup

```bash
npm install
cp .env.example .env   # fill in real beta credentials
npm run ui              # http://localhost:3002
```

## The B2C API surface

17 requests across 8 functional areas (Auth, Master Data, Flight Search, Fare Pricing,
Ancillary Services, Profile, Promo, Create Itinerary) — see the shared Postman collection
`B2C_Airline_Collection.postman_collection.json` for the ground truth on every payload shape.

Structurally the same core flow as B2B: `Signature → ExpressSearch → GetExpSearch (poll) →
SmartPricer → GetSPricer (poll) → CreateItinerary`. Two real differences: auth is just
`MerchantID + ApiKey` (no Password/AgentCode/BrowserKey), and booking is guest-checkout shaped
(`IsGuest: true`, no corporate/GST fields).

## Running scenarios (once features exist)

```bash
npm run test:scenarios          # full suite, beta
npm run test:scenarios:live     # full suite, live (once live creds are set)
npm run test:smoke              # SUITE=smoke
```

Env-var scoping: `AIRLINE=`, `SUITE=`, `SECTOR_TYPE=`, `TRIP_TYPE=`, `TAGS=`, `PRIORITY=`
— same filtering mechanics as the B2B project (`scenarios/filter.js`).

---
*Bootstrapped from api-automation-node, 2026-09-17.*
