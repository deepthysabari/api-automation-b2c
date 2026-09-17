# Phase 1 — core flow verified live against the B2C beta API

**Date:** 2026-09-17 · **Author:** Deepthy (with Claude)

## What was verified

All five core steps of the B2C flow, live against beta, one stage at a time:

1. **Signature** (`POST {{UtilsURLTest}}/Utils/Signature`) — `{ MerchantID, ApiKey }` only, no
   agent login. `Code 200`, valid `Token`/`TUI` returned.
2. **ExpressSearch** (`POST {{AvlURLTest}}/flights/ExpressSearch`) — confirmed the `SecType`
   field (domestic/international) and the third subdomain split (`AvlURLTest`, separate from
   `FlightURLTest`) both work as documented in the Postman collection.
3. **GetExpSearch** (`POST {{FlightURLTest}}/flights/GetExpSearch`) — polling pattern identical
   to B2B's (`Completed: "True"/"False"`, retry until true). Confirmed live inventory returns
   (100–228 journeys on some polls).
4. **SmartPricer** (`POST {{FlightURLTest}}/Flights/SmartPricer`)
5. **GetSPricer** (`POST {{FlightURLTest}}/Flights/GetSPricer`)

**Confirmed end-to-end on a real fare**: DEL→BOM, 2026-09-24, Air India flight AI 2439 via GDS
provider `SB`, ₹6,730 net fare — `SmartPricer` returned `Code 200` with the priced `Trips`
already attached (synchronous, not async for this provider), `GetSPricer` confirmed the same
`NetAmount` on first poll.

**Auth confirmed generic**: `engine/executor.js`'s existing `Authorization: Bearer {{Token}}`
injection (from `context.Token`, set by Signature's response) works unchanged for B2C — no
executor change needed, despite B2B never having used it this way (B2B's own flows don't rely
on a Bearer token the same way).

## A real finding, not a blocker

Journeys from certain providers **fail to price**: `SmartPricer` returned `Code 1601 "No Record
found"` immediately (not async) for every journey from provider `TSO` (an aggregator/consolidator
code, distinct from GDS-routed `SB`→AI journeys which priced fine). Reproduced 2/2 times on
different searches. Not investigated further yet — worth a dedicated look once `airlines/`
adapters are being built, to confirm whether this is a genuine beta-environment gap for that
provider, a payload nuance specific to aggregator-sourced journeys, or expected (mirrors a
provider-quirk pattern also seen in the B2B project's S3 verification work).

**Inventory on the beta environment is thin and route-dependent** — several route/date
combinations tried returned only 0–3 journeys from a single provider, some returned 100+.
Route selection matters for reliable live-verification; don't assume any given route/date has
rich inventory without checking.

## Templates captured

Built from the *actual verified* request/response shapes (not the Postman sample alone —
cross-checked against a real successful live call):
- `templates/express_search_request.json`
- `templates/get_exp_search_request.json`
- `templates/smart_pricer_request.json`
- `templates/get_s_pricer_request.json`

Placeholder convention matches B2B: `{{...}}` for executor-context-resolved values (TUI, Token),
`<<...>>` for adapter/dataset-injected values (trips, pax mix, airline code) — not yet wired
into an actual `airlines/<CODE>/adapter.js` flow-step definition; that's next.

## Still open for Phase 1

- No `airlines/<CODE>/adapter.js` built yet — this session verified the raw HTTP flow with
  hand-written scripts, not through the engine's adapter/flow-step mechanism. Building the
  actual adapter (wiring these templates into `getFlowSteps`) is the next concrete step.
- SSR, SeatLayout, CreateItinerary not yet touched (Phases 2–3).
- The `TSO`-provider pricing gap above needs a decision: skip those journeys in scenario
  selection, or investigate further.
