# CLAUDE.md - Agent Guidelines (api-automation-b2c)

This project is **bootstrapped from `api-automation-node`** (the B2B automation engine — see
`../api test engine/`), adapted for the B2C airline booking API. Most of the engine layer is
ported unchanged; read the sibling project's `CLAUDE.md` and `FRAMEWORK_DEVELOPER_GUIDE.md` for
the deep architecture — this file only calls out what's different here.

## 🛠 Project Context — what's different from the B2B project
- **Simpler auth**: B2C's Signature call is `{ MerchantID, ApiKey }` only — no Password,
  AgentCode, BrowserKey, or agent login. See `templates/signature_request.json` and
  `config/environmentStore.js`'s `KEYS`.
- **Guest-checkout booking model**: `CreateItinerary`'s `ContactInfo.IsGuest` is `true`; no
  corporate/GST fields to populate. The traveller/passenger validator needs its own shape
  (ported from B2B unchanged for now — revisit once CreateItinerary is wired up in Phase 3).
- **Three API subdomains, not one**: `UtilsURLTest` (Signature, GetProfile),
  `FlightURLTest` (search-results, pricing, SSR, seat layout, promo, booking), and
  `AvlURLTest` (ExpressSearch specifically). See the shared Postman collection for the exact
  split — don't assume one base URL covers everything.
- **Promo flow**: `GetPromos → CheckPromo → CreateItinerary` is the correct chain (captures
  `checkedPromoRef/Code/Amt/ConvFee/Type` from CheckPromo for CreateItinerary's `Auxiliaries`).
  The collection's own sample `CreateItinerary` request has a **known bug** — a hardcoded
  `"ZEROFEE"` promo code that doesn't match anything `GetPromos` actually returns — worth a
  dedicated validator once Promo is wired up (Phase 2).
- **No airline adapters yet**: `airlines/` only has the generic auto-discovery infra
  (`base/`, `registry.js`) ported from B2B. Every carrier falls back to the generic B2B
  adapter until a B2C-specific quirk is found and an `airlines/<CODE>/adapter.js` is added —
  same onboarding process as the B2B project, don't build one preemptively.

## 📜 Development Rules (unchanged from the B2B project)
0. **Live-only, no mocks** (non-negotiable): every scenario hits the real B2C beta/live API.
   No mock, stub, fixture, or synthetic-response logic anywhere. No live inventory → SKIP,
   never fabricated.
1. **No Hardcoded Logic**: carrier quirks belong in `airlines/<CODE>/adapter.js`; business flow
   belongs in `.feature` files under `features/`.
2. **Context Isolation**: chain data via the step `save`/`saveExpressions` context, never
   module-level state.
3. **Validation First**: new flows specify a validator sequence explicitly
   (`Then validate using validators "..."`).
4. **Error Handling**: fail fast — an unregistered airline or a missing config key throws
   immediately, it does not silently fall back.
5. **Onboarding a new B2C airline**: register it in `configs/airlines.json` *before*
   referencing its code in a feature file — mirrors the B2B guardrail in
   `engine/airlineResolver.js`.

## Current status
Phase 0 (scaffolding) complete: engine ported and sanity-checked, config layer adapted for
B2C's credential shape, dashboard rebranded. **No feature files, no airline adapters, no
templates beyond `signature_request.json` yet** — that's Phase 1: prove Signature →
ExpressSearch → GetExpSearch → SmartPricer → GetSPricer against the live B2C beta API, one
stage at a time, same discipline as the B2B project. See `docs/changes/` for the plan document
and progress log.

---
*Keep the engine lean, the data rich, and the tests isolated.*
