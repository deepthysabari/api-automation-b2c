# B2C API — confirmed quirks and known gaps

Everything here was **verified live** against the B2C beta API. Read this before investigating
"why doesn't X work" — it may already be answered. The full trail for each item is in
`docs/changes/` (file named in brackets).

If you find something new, add it here *and* write a `docs/changes/` entry for it.

---

## How the API really behaves (differs from what you'd assume)

### There is no preferred-airline search
`ExpressSearch` accepts `Parameters.Airlines` / `preferedAirlines` but **ignores them**. Every
search returns all carriers on that sector (a "9I" search on COK-BLR returned 213 journeys, only 3
of them 9I). The engine no longer sends the filter at all.

So **"test airline X's availability" means:** search a sector X is known to fly, then check X
appears in the results. That's what `Given user selects airline "X"` does — it only chooses
*which sector* gets searched (`engine/sectorResolutionEngine.js`); the availability validator
then fails if zero journeys belong to X. Other carriers appearing alongside X is normal and only
logged as a warning. [2026-09-21-phase1-first-feature-file.md]

### Cabin class is a top-level `Cabin` field
Not `Trips[].OnwardCabin` (the B2B assumption — it silently always returned Economy). All four
cabins work: `E`, `PE`, `B`, `F`. [2026-09-22-cabin-class-top-level-field.md]

### Fare categories go in `Parameters.PaxCategory`
Not boolean flags like `IsSeniorCitizen` / `IsStudentFare` (those have no effect at all).
| Code | Meaning | Status |
|---|---|---|
| `SCP` | Senior citizen | Works, domestic only |
| `STU` | Student | Works, domestic only |
| `DEF` | Defence | Wired correctly, but **no live inventory found yet** (6 samples) — needs a real route/date from a live capture before a feature can be built |

International student/senior fares returned nothing on every route tried — treat them as
domestic-only (matches Indian aviation policy). [2026-09-23-fare-category-paxcategory-fix.md,
2026-09-23-student-and-defence-fare.md]

### `IsDirect` works
Filters results to `Stops: 0`. One known live imperfection: flight `S5 183` came back with
`Stops: 1` in 2/2 domestic runs — an API data issue, not a test bug.

### Three base URLs, not one
`UtilsURLTest` (Signature, GetProfile), `AvlURLTest` (ExpressSearch only), `FlightURLTest`
(everything else). [2026-09-17-phase1-core-flow-live-verification.md]

### Some providers fail to price
`SmartPricer` returns `Code 1601 "No Record found"` for journeys from provider `TSO`
(reproduced 2/2). GDS-routed journeys (e.g. `SB` → AI) price fine. Not investigated yet.

### Beta inventory is thin
Some route/date combinations return nothing. That's why scenarios use `retry with alternate
dates if no availability`, and why a scenario with no inventory **SKIPs** rather than fails.

---

## Features that do NOT exist — don't build tests for them

- **Nearby-airport search** — B2C has no such feature. `IsNearbyAirport` is still in the code
  (harmless) but nothing should use it.

---

## Where each carrier is actually found

**Domestic** (pool: `config/sectorPools/domestic.json`)
- `6E`, `AI`, `IX`, `QP` — present on most routes.
- `SG` — only seen on DEL-BOM domestically.
- `9I` → COK-BLR · `S5` → BLR-PNQ · `IC` → SDW-PNQ (only carrier on that route). These three
  each have a dedicated "niche" scenario because they're on only one pool route.
- `SP1` (FlyWithOS, a provider) — BOM-LKO and DEL-BLR.

**International** (pool: `config/sectorPools/international.json`, Kerala/Mumbai ↔ Dubai/Abu Dhabi)
- `IX` — on every route.
- `XY` → CCJ-DXB only (has a niche scenario).
- `3L` → AUH routes · `FZ`, `G9`, `SG`, `EK` → 2–4 routes each.
- `QP`, `AK`, `TZ`, `OD`, `J9` — **not found on any route in the pool.** They need different
  destinations (Kuwait, Malaysia, Singapore) — ask the business for those corridors.

**Rule of thumb used so far:** a carrier on exactly one pool route gets its own niche scenario;
a carrier on several routes is checked through the common all-airlines scenarios.

---

## Open questions / known gaps (good starter tasks)

| Item | What's needed |
|---|---|
| `DOM-DEL` sector | Given by the business early on, but `DOM` isn't an airport code — ask what was meant |
| `SG` flags in `configs/airlines.json` | Says domestic-only, but SG was seen on 3 international routes — confirm and fix |
| `SG` niche scenario | On only one domestic route, but has no niche scenario (inconsistent with the rule above) |
| `G9A`, `GP`, `HR` | Seen live but not registered in `configs/airlines.json` |
| `SP1` provider | Confirmed live but no `validate provider "SP1" availability` step anywhere |
| MAA-DEL | Domestic search returned `SQ`/`SV` (international carriers) — possible codeshare, not investigated |
| 3-leg international multicity | `COK-DXB-LHR-ZGG` returned empty; set aside by decision |
| Defence fare | Needs a live route/date with `DEF` inventory |
| `TSO` pricing failure | See "Some providers fail to price" above |
