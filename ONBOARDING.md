# Onboarding — api-automation-b2c

Welcome! This project tests the **B2C airline booking API** (the API behind the consumer flight
booking site) by running real searches against the live beta environment and checking the
responses. This guide gets you from zero to owning tasks in about three weeks.

You'll be working with **Claude Code**. It reads `CLAUDE.md` and `docs/API_QUIRKS.md`
automatically when relevant, so it knows the project rules — but *you* own the decisions, so read
those two files yourself too.

---

## 1. The domain in 5 minutes

| Term | Meaning |
|---|---|
| **Sector** | A route, written `FROM-TO` with airport codes, e.g. `COK-BLR` (Kochi → Bengaluru) |
| **Domestic / International** | Within India / crossing a border. The API calls this `SecType` |
| **OW / RT / Multicity** | One-way / round trip / several legs (e.g. DEL-BOM, then BOM-BLR) |
| **Carrier code** | 2-letter airline code: `6E` IndiGo, `AI` Air India, `IX` Air India Express, `QP` Akasa, `SG` SpiceJet, `9I` Alliance Air, `S5` Star Air, `IC` Fly91, `EK` Emirates… Full list: `configs/airlines.json` |
| **LCC** | Low-cost carrier (IndiGo, SpiceJet…) vs. full-service (Air India, Emirates…) |
| **Provider** | Where a fare comes from — a GDS like Sabre (`SB`) or an aggregator. One airline can be sold through several providers |
| **Pax** | Passengers: `ADT` adult, `CHD` child, `INF` infant |
| **Cabin** | `E` Economy, `PE` Premium Economy, `B` Business, `F` First |
| **Fare category** | Special fares: senior citizen, student, defence |
| **SSR** | Extras: meals, baggage, seats |
| **TUI** | An ID the API returns at each step; the next step needs it. The engine passes it along for you |

### The booking flow (what we test, in order)

```
Signature ──► ExpressSearch ──► GetExpSearch ──► SmartPricer ──► GetSPricer ──► (SSR / Promo) ──► CreateItinerary
  login        start search     poll for results   price a flight   poll for price      extras          book (guest)
```

Each step's output feeds the next. Today our automated tests cover the **first three steps**
(search/availability). Everything after that is the roadmap (section 5).

### One thing that surprises everyone
B2C has **no "search only this airline" option**. Every search returns all airlines on that
route. So to test IndiGo's availability, we search a sector IndiGo flies and check IndiGo shows up
in the results. See `docs/API_QUIRKS.md` for this and other confirmed quirks.

---

## 2. Setup (day 1)

1. `npm install`
2. Copy `.env.example` to `.env`. Ask Deepthy for the beta `MerchantID` and `ApiKey`.
   **Never commit `.env`.**
3. Check it works:
   ```bash
   TAGS=niche npx jest tests/scenarios.test.js --testTimeout=90000
   ```
   You should see 4 scenarios: PASSED, or SKIPPED if there are no flights that day.
4. Optional dashboard: `npm run ui` → http://localhost:3002

### Running tests
```bash
npm run test:scenarios                 # everything
npm run test:smoke                     # the smoke suite (suites/smoke.json)
TAGS=domestic,oneway npm run test:scenarios
SECTOR_TYPE=INT npm run test:scenarios
```

### Reading results
- **PASSED** — the live API returned what we expected.
- **FAILED** — the live API returned something wrong. Investigate before re-running.
- **SKIPPED** — no flights available for that route/date (common on beta). Not a bug, but
  if one scenario skips every time, raise it.
- **WARN** lines inside a pass are worth reading, but they aren't failures.

---

## 3. How a test works

```
features/*.feature   ──►  scenarios/bddInterpreter.js  ──►  engine/  ──►  validators/
plain-English steps        turns steps into settings        calls the      checks the
                                                            live API       response
```

Example — `features/common/01_availability/domestic/ow_cabinclass.feature`:

```gherkin
Scenario Outline: Validate Domestic Oneway <cabinName> Cabin Availability
  Given user searches all airlines
  And user selects cabin "<cabin>"
  When search for domestic OW flight
  Then validate at least one flight result exists
  And validate all returned flights belong to "<cabin>"

  Examples:
    | cabin | cabinName |
    | E     | Economy   |
    | B     | Business  |
```

Most of your work will be in `.feature` files. Only some sentences are understood: the full
list is in `scenarios/bddInterpreter.js` (the numbered comments). If you need a sentence that
doesn't exist yet, that's a code change, so plan it with Claude Code and get it reviewed.

| Folder | What's in it |
|---|---|
| `features/` | The test scenarios (Gherkin) |
| `config/sectorPools/` | Which sectors we search, and which airlines fly each one |
| `configs/airlines.json` | Every airline we know about, with what it supports |
| `validators/` | The checks run on responses |
| `templates/` | Request body shapes for each API call |
| `docs/changes/` | Dated log of every piece of work: what was done, what was found |
| `docs/API_QUIRKS.md` | Confirmed API behaviour and open questions — **read this** |

---

## 4. Rules that are never broken

1. **Live API only.** No mocks, no fake responses. If there are no flights, the test SKIPs.
2. **No airline-specific hacks in shared code.** Airline quirks go in `airlines/<CODE>/adapter.js`
   (none exist yet, so don't create one unless a real quirk is proven).
3. **Register an airline in `configs/airlines.json` before using its code** in a feature file.
4. **Every scenario states what it validates** (a `Then validate ...` step).
5. **Log your work.** Each task gets a `docs/changes/YYYY-MM-DD-short-name.md` entry covering
   what was done, what was verified live, and what was found. Look at existing entries for the format.

---

## 5. Where the project is, and what's next

| Phase | Status |
|---|---|
| 0. Scaffolding | Done |
| 1a. Core flow verified by hand (Signature → GetSPricer) | Done (2026-09-17) |
| 1b. Availability scenarios (OW/RT/multicity, domestic + international, cabin, pax mix, direct, senior, student) | Done — 18 feature files |
| 1c. **Pricing scenarios** (SmartPricer → GetSPricer) | **Next** |
| 2. SSR, seat layout, Promo (GetPromos → CheckPromo) | Planned |
| 3. CreateItinerary (guest booking) | Planned |

Smaller open items are listed in the "Open questions" table in `docs/API_QUIRKS.md`. They make
good first tasks.

---

## 6. How tasks will come to you

Each task will be written like this:

```
Capability:  what we're testing, in one line
Search:      which sector / trip type / pax / cabin
Assert:      what must be true in the response
SKIP when:   what counts as "no inventory" rather than a failure
Done when:   live run passes (or skips for a stated reason) + docs/changes entry written
```

If any of those five lines is unclear, ask before you start.

### Working a task with Claude Code
1. Paste the task in and ask Claude to **explain its plan before changing anything**.
2. Check the plan against the rules in section 4 and `docs/API_QUIRKS.md`.
3. Let it make the change, then **run the scenario live yourself** and read the output.
4. Have it write the `docs/changes/` entry, and **read it yourself.** You should be able to
   explain every line.
5. Open a branch and pull request for Deepthy to review. Don't push to `master`.

If something unexpected comes back from the API, write down what happened (the request, the
response, the date) before trying to fix it. Unexpected results have been the most valuable
findings on this project.

---

## 7. Your first three weeks

**Week 1 — learn**
- Read this file, `CLAUDE.md`, `docs/API_QUIRKS.md`, and two `docs/changes/` entries
  (start with `2026-09-21-phase1-first-feature-file.md`).
- Run the smoke suite every day for a few days. Notice which scenarios skip and why.
- Explain back to Deepthy: why does a "9I" test pass when most results are Air India?

**Week 2 — small changes**
- Pick 1–2 items from the open-questions table (e.g. add a `validate provider "SP1"` step, or add
  an SG niche scenario).

**Week 3 — your first feature**
- Own one new scenario end to end (e.g. IndiGo Business-class availability), including the live
  run, the changes log and the pull request.

**After that** — the pricing phase (1c), one step at a time, with review.

---

## 8. Who to ask
**Deepthy**: credentials, business scope (which sectors and
airlines matter), and any "is this a bug or expected?" question. When in doubt, ask. A
five-minute question is cheaper than a day spent on a wrong assumption.
