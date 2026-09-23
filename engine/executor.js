'use strict';

const apiClient    = require('../utils/apiClient');
const dataGenerator = require('../utils/dataGenerator');
const airlineResolver = require('./airlineResolver');
const _            = require('lodash');

/**
 * Executor — Executes a single step and resolves all placeholders.
 *
 * Enhanced from v1 to support:
 *   - Airline adapter payload normalization
 *   - saveExpressions for computed/constructed variable values
 *   - Structured result objects (no silent failures)
 */
class Executor {
  // GetSPricer resolves asynchronously; how long to wait for the priced fare to materialise.
  PRICE_POLL_ATTEMPTS = 10;
  PRICE_POLL_DELAY_MS = 1500;

  // Per-request timeout for a single GetExpSearch poll attempt — raised above apiClient's
  // 60s default (see the getSearch branch below for why).
  SEARCH_POLL_TIMEOUT_MS = 120000;

  // CreateItinerary has been observed taking longer than apiClient's flat 60s default to
  // respond for some carriers (e.g. IX domestic oneway, reproduced twice live) — raised the
  // same way GetExpSearch's poll timeout was, so a slow-but-eventually-successful call isn't
  // cut off mid-flight.
  CREATE_ITINERARY_TIMEOUT_MS = 120000;

  /**
   * Build the axios request config for a step, resolving every placeholder against the
   * CURRENT context. Extracted so a step can be re-issued after the context moved on
   * (the date-retry path below re-runs ExpressSearch, which mints a new TUI, and must
   * then re-resolve the GetExpSearch body against that new TUI).
   * @private
   */
  _buildRequestConfig(step, context) {
    const resolvedStep = this._resolvePlaceholders(step, context);
    const req = resolvedStep.request || resolvedStep;

    // Parse string body to JSON if needed
    let body = req.body || req.payload;
    if (typeof body === 'string' && (body.startsWith('{') || body.startsWith('['))) {
      try { body = JSON.parse(body); } catch (_) { /* keep as string */ }
    }

    // Auth header — inject Bearer token from context if available
    const headers = { ...req.headers };
    if (context.Token) {
      headers['Authorization'] = `Bearer ${context.Token}`;
    }

    const requestConfig = { method: req.method, url: req.url, data: body, params: req.params, headers };

    // A broad, unfiltered international GDS GetExpSearch poll (no airline filter, all
    // providers) has been observed taking longer than apiClient's flat 60s default to
    // answer a single poll attempt (e.g. DEL-DOH oneway, reproduced twice live). GetSearch
    // polls get a longer per-request budget so a slow-but-eventually-successful attempt
    // isn't cut off mid-flight; every other step keeps apiClient's 60s default.
    if (step._stepKey === 'getSearch') {
      requestConfig.timeout = this.SEARCH_POLL_TIMEOUT_MS;
    }
    if (step._stepKey === 'createItinerary') {
      requestConfig.timeout = this.CREATE_ITINERARY_TIMEOUT_MS;
    }

    return requestConfig;
  }

  /**
   * Execute a single step.
   * @param {Object} step    - Step definition (from airline adapter)
   * @param {Object} context - Per-scenario context store (mutable)
   * @returns {Object} Axios response
   */
  async execute(step, context) {
    const requestConfig = this._buildRequestConfig(step, context);

    try {
      let response;
      if (step._stepKey === 'getSearch') {
        let outcome = await this._pollSearch(requestConfig);

        // A search that finished cleanly (Code 200 / Completed "True") but carries no journey at
        // all means the provider sells nothing matching on that date/route/fare — a live-inventory
        // fact, not a defect. Skip, exactly as an unsellable fare at GetSPricer does; never fake a
        // result. Only a COMPLETED search qualifies: zero journeys with Completed still "False"
        // means the poll budget ran out mid-resolve, which IS a defect and must stay a failure.
        //
        // OPT-IN date retry (step._dateRetry, wired by runner.js only when the scenario carries
        // dimensions.retryDatesOnEmptyInventory): a low-frequency carrier genuinely does not fly
        // every day, so an empty completed search on ONE date says nothing about whether the
        // carrier serves the route at all. For those scenarios only, the SAME search (same pax
        // mix, cabin, carrier/preferred filter, route) is re-issued on later dates before giving
        // up. Every other scenario stays strictly date-deterministic — an empty search there is
        // still an immediate SKIP on the one date asked for.
        // Carrier-scoped counting ONLY applies when this step BOTH names a specific carrier
        // (step._expectedAirline) AND opted into date-retry tolerance (step._dateRetry, from
        // `dimensions.retryDatesOnEmptyInventory` — see runner.js `_wireDateRetry`). Without
        // that opt-in, a preferred-mode scenario stays strictly date-deterministic and falls
        // through to the validator for a hard pass/fail on carrier absence, same as always.
        // With it: B2C's ExpressSearch never filters by carrier, so a niche carrier's own sector
        // always carries hundreds of OTHER carriers' journeys regardless of whether IT has any —
        // total journeyCount can never be 0 there, which would silently defeat both the retry
        // below and the SKIP check after it if left unscoped.
        const relevantCount = (o) => (step._expectedAirline && step._dateRetry)
          ? this._countMatchingJourneys(o.aggregatedTrips, step._expectedAirline)
          : o.journeyCount;

        const datesTried = [];
        if (outcome.searchCompleted && relevantCount(outcome) === 0 && step._dateRetry) {
          const { searchStep, extraAttempts, dayStep } = step._dateRetry;
          const original = this._searchStepWithShiftedDates(searchStep, 0);

          if (!original) {
            console.log('      [DATE RETRY] search step carries no shiftable trip date — skipping date retry.');
          } else {
            datesTried.push(original.dates.join(' + '));

            for (let attempt = 1; attempt <= extraAttempts; attempt++) {
              // Offsets are always measured from the ORIGINAL date (+2, +4, ...), never
              // compounded off the previous attempt.
              const offset = attempt * dayStep;
              const shifted = this._searchStepWithShiftedDates(searchStep, offset);
              if (!shifted) break;

              console.log(
                `      [DATE RETRY] No inventory on ${datesTried[datesTried.length - 1]}, ` +
                `retrying with ${shifted.dates.join(' + ')} (attempt ${attempt}/${extraAttempts}, +${offset} days)...`
              );

              // Re-run ExpressSearch on the new date. It mints a fresh TUI into the context,
              // so the GetExpSearch body must be re-resolved against that new TUI.
              await this.execute(shifted.step, context);
              const retryConfig = this._buildRequestConfig(step, context);
              outcome = await this._pollSearch(retryConfig);
              datesTried.push(shifted.dates.join(' + '));

              // A retry that did NOT complete is a defect (poll budget spent mid-resolve), not
              // an inventory fact — stop retrying and let it surface as a failure, exactly as
              // an incomplete first attempt does.
              if (!outcome.searchCompleted) break;

              if (relevantCount(outcome) > 0) {
                console.log(
                  `      [DATE RETRY] Inventory found on ${shifted.dates.join(' + ')} ` +
                  `(retry attempt ${attempt}/${extraAttempts}) — continuing with that date.`
                );
                break;
              }
            }
          }
        }

        if (outcome.searchCompleted && relevantCount(outcome) === 0) {
          const carrierNote = step._expectedAirline ? ` for "${step._expectedAirline}"` : '';
          if (datesTried.length > 1) {
            throw new Error(
              `SKIPPED: no live inventory${carrierNote} on any of the dates tried (${datesTried.join(', ')}) — ` +
              'the provider offers no matching flight for this route/fare in that window'
            );
          }
          throw new Error(
            `SKIPPED: no live inventory${carrierNote} — the search completed ` +
            `(Code ${outcome.finalResponse.data?.Code ?? '?'}) with an empty Trips result, ` +
            'so the provider offers no matching flight for this route/date/fare'
          );
        }

        response = outcome.finalResponse;
      } else if (step._stepKey === 'getPrice') {
        // GetSPricer resolves asynchronously AND can report a mid-flight fare change; the two
        // interleave, so handle both in ONE loop until the fare confirms, is declared unsellable,
        // or the attempt budget is spent:
        //   Code 501 "No Data Found" — the priced result isn't ready yet → re-poll the same TUI.
        //   Code 1500 "fare changed" — IF the response carries a genuinely different TUI, that
        //     TUI is a fresh pricing session → re-confirm with it. But international oneway
        //     (verified live on MAA-SIN, DEL-DOH, COK-MCT) routinely returns 1500 echoing back
        //     the SAME TUI it was just called with, already carrying the complete, final priced
        //     Trips/NetAmount — there is no new session to confirm. Re-submitting GetSPricer with
        //     that unchanged TUI doesn't re-confirm anything; it flips to a 501 that never
        //     recovers, turning a fare that already priced into a false SKIP. So a same-TUI 1500
        //     is terminal, exactly like 200 (pricingValidator/businessValidator record the fare
        //     change as an accepted warning, not an error).
        // (Handling 501/1500 as two separate sequential loops let a 501 *produced by* a 1500
        // re-confirm slip through unpolled, replacing a good price with a spurious "No Data Found".)
        let priceConfig = requestConfig;
        response = await apiClient(priceConfig);
        let attempts = 0;
        let fareChanges = 0;
        while (attempts < this.PRICE_POLL_ATTEMPTS) {
          const code = String(response.data?.Code ?? '');
          if (code === '501') {
            attempts++;
            console.log(`      [PRICE POLL] GetSPricer not ready (Code 501 "No Data Found") — retry ${attempts}/${this.PRICE_POLL_ATTEMPTS}...`);
            await new Promise(r => setTimeout(r, this.PRICE_POLL_DELAY_MS));
            response = await apiClient(priceConfig);
            continue;
          }
          if (code === '1500' && response.data.TUI && response.data.TUI !== priceConfig.data.TUI && fareChanges < 3) {
            fareChanges++;
            console.log(`      [FARE CHANGE] GetSPricer reported a fare change — re-confirming with new TUI (${fareChanges}/3)...`);
            priceConfig = { ...priceConfig, data: { ...priceConfig.data, TUI: response.data.TUI } };
            response = await apiClient(priceConfig);
            continue;
          }
          break; // 200 / 2255 / a same-TUI 1500 (already final) / any other terminal code
        }

        // The fare that SmartPricer priced can be unavailable at GetSPricer — a real business
        // outcome, not a defect. Surface it as a SKIP ("not available at pricing"), the same way
        // an unsupported premium cabin is skipped, rather than failing the scenario:
        //   Code 2255 "non combinable product class" / FailedFareRestriction — the provider
        //     advertises the combination but will not ticket it (e.g. an IndiGo international
        //     multi-leg self-quote; the portal itself returns 2255 here).
        //   Code 501 still after the full poll budget — the priced result never materialised, so
        //     there is no sellable fare to verify. (A transient 501 resolves inside the loop above,
        //     so only a genuinely stuck one reaches here.)
        const priceCode = String(response.data?.Code ?? '');
        const priceMsg = Array.isArray(response.data?.Msg)
          ? response.data.Msg.join(' ')
          : String(response.data?.Msg ?? '');
        const notSellable = priceCode === '2255' || /non\s*combinable|FareRestriction/i.test(priceMsg);
        const neverReady = priceCode === '501';
        if (notSellable || neverReady) {
          throw new Error(
            `SKIPPED: fare unavailable at pricing (GetSPricer Code ${priceCode}: ` +
            `${priceMsg.trim() || 'no priced data'}) — ` +
            (notSellable ? 'the selected combination is not sellable' : 'pricing never materialised after polling')
          );
        }
      } else if (step._stepKey === 'createItinerary') {
        // CreateItinerary can ALSO report a mid-flight fare change, the same Code 1500 GetSPricer
        // uses — verified live on a BA international roundtrip: the response carried a genuinely
        // different TUI and a real new fare, with TransactionID 0 (nothing was actually booked at
        // the stale price). Same re-confirm pattern as GetSPricer: retry with the response's own
        // TUI, carrying its confirmed fare forward — the priced/booked response is authoritative
        // (see docs/changes/2026-07-17-itinerary-change-handling.md, "changes accepted, not
        // failed"). A same-TUI 1500 (no new session to confirm) is terminal, exactly like
        // GetSPricer's.
        //
        // The request's NetAmount field is the fare-only amount — the server adds SSRAmount on
        // its own to produce the response's top-level (combined) NetAmount. Verified live
        // (2026-08-11, TRV-SHJ G9): a 1500 response carried AirlineNetFare 46874.17, SSRAmount
        // 1050.00, combined NetAmount 47924.17; retrying with the RESPONSE's own combined
        // NetAmount as the request's NetAmount double-counts SSRAmount server-side and is
        // rejected with Code 1000 "Net Amount Mismatch". Retrying with AirlineNetFare instead
        // succeeded (Code 200, real TransactionID assigned).
        let itineraryConfig = requestConfig;
        response = await apiClient(itineraryConfig);
        let fareChanges = 0;
        while (fareChanges < 3) {
          const code = String(response.data?.Code ?? '');
          if (code === '1500' && response.data.TUI && response.data.TUI !== itineraryConfig.data.TUI) {
            fareChanges++;
            console.log(`      [FARE CHANGE] CreateItinerary reported a fare change — re-confirming with new TUI (${fareChanges}/3)...`);
            itineraryConfig = {
              ...itineraryConfig,
              data: {
                ...itineraryConfig.data,
                TUI: response.data.TUI,
                NetAmount: response.data.AirlineNetFare,
                SSRAmount: response.data.SSRAmount
              }
            };
            response = await apiClient(itineraryConfig);
            continue;
          }
          break; // 200 / a same-TUI 1500 (already final) / any other terminal code
        }
      } else {
        response = await apiClient(requestConfig);
      }

      if (step._stepKey === 'ssr') {
        this._extractSelectedSSR(response, context, step._legIndex);
      }

      this._extractVariables(step.save, response, context);
      this._computeExpressions(step.saveExpressions, response, context);
      return response;
    } catch (error) {
      if (error.response) {
        // A step can error out (e.g. the live SSR endpoint occasionally 500s with a raw ASP.NET
        // crash page instead of JSON) rather than just returning a business-level failure code.
        // Still run _extractSelectedSSR so a later CreateItinerary_Leg{N} step degrades to an
        // empty selection instead of crashing on "Placeholder missing value: SelectedSSR_{N}" —
        // ssrDetailsValidator only warns (not fails) on a response with no Trips[], so the SSR
        // step itself can be reported PASSED even though the call errored.
        if (step._stepKey === 'ssr') {
          this._extractSelectedSSR(error.response, context, step._legIndex);
        }
        this._extractVariables(step.save, error.response, context);
        return error.response;
      }
      throw error;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // GetExpSearch poll cycle
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Run one full GetExpSearch poll cycle for an already-built request config and aggregate
   * every journey seen across the polls.
   *
   * @returns {{finalResponse:Object, aggregatedTrips:Array|null, searchCompleted:boolean, journeyCount:number}}
   * @private
   */
  async _pollSearch(requestConfig) {
    let attempts = 0;
    // International round trips were observed needing ~25 polls to fully
    // resolve out of cache (docs/API_FLOW_ANALYSIS.md §4); 15 attempts cut
    // the search off early, leaving journeys stuck as unresolved "|C"
    // cache placeholders. Bumped from 30 to 40 (2026-09-22): the two-consecutive-
    // Completed:"True" confirmation added above needs one extra poll per search, and at 39
    // concurrent scenarios that pushed a couple of slower searches past the old ceiling —
    // poll budget exhausted with Completed still "False", a genuine defect-shaped failure, not
    // a SKIP. Reproduced live under load; not seen at 25 scenarios. The extra headroom costs
    // nothing on a search that resolves in the old budget (loop just breaks early as before).
    const maxAttempts = 40;
    const delayMs = 1500;
    let aggregatedTrips = null;
    let finalResponse = null;
    // Identity of every journey already aggregated, one Set per trip leg.
    const seenPerTrip = [];
    // Require Completed:"True" on two CONSECUTIVE polls before trusting it — the async result
    // index can still be mid-write even after the flag flips once. Reproduced live 2026-09-22:
    // under Jest's concurrent load, a marketplace search would occasionally come back missing a
    // GDS provider (e.g. SB) from an otherwise rich, near-complete result, never reproducible in
    // a serial/standalone check on the exact same route/date — i.e. genuinely a completion-
    // timing race, not a live-inventory fact. The extra confirmatory poll merges into the same
    // aggregation below (union-only, never removes anything), so the cost is one ~1.5s round
    // trip on the common case (nothing changes) in exchange for closing that gap.
    let sawCompletedOnce = false;

    while (attempts < maxAttempts) {
      const currentResponse = await apiClient(requestConfig);
      finalResponse = currentResponse;

      if (currentResponse.data && Array.isArray(currentResponse.data.Trips)) {
        if (!aggregatedTrips) aggregatedTrips = [];

        currentResponse.data.Trips.forEach((trip, ti) => {
          if (!aggregatedTrips[ti]) {
            aggregatedTrips[ti] = { ...JSON.parse(JSON.stringify(trip)), Journey: [] };
            seenPerTrip[ti] = new Map();   // identity -> position in Journey
          }
          const existingJourneys = aggregatedTrips[ti].Journey;
          const seen = seenPerTrip[ti];

          (trip.Journey || []).forEach(newJ => {
            const id = this._journeyIdentity(newJ);
            const copy = JSON.parse(JSON.stringify(newJ));

            if (!seen.has(id)) {
              seen.set(id, existingJourneys.length);
              existingJourneys.push(copy);
              return;
            }

            // The same journey is re-sent across polls as the search resolves, and its fare
            // can change. Keeping the FIRST copy hands SmartPricer a stale Amount, which it
            // rejects ("No Data Found"). But taking the LATEST blindly is just as wrong: the
            // provider also re-sends rows unpriced (NetFare 0), which would wipe out a fare
            // we already had and leave "no bookable fare".
            //
            // So: a priced row is never downgraded to an unpriced one. Otherwise the newer
            // copy wins, keeping its original position so ordering stays stable.
            const pos = seen.get(id);
            const existing = existingJourneys[pos];
            const newIsPriced = Number(copy.NetFare) > 0;
            const oldIsPriced = Number(existing.NetFare) > 0;

            if (newIsPriced || !oldIsPriced) {
              existingJourneys[pos] = copy;
            }
          });
        });
      }

      const isCompleted = currentResponse.data && (currentResponse.data.Completed === "True" || currentResponse.data.Completed === true);
      console.log(`      [POLL] GetExpSearch attempt ${attempts + 1}/${maxAttempts} - Completed: "${currentResponse.data?.Completed}"`);

      if (isCompleted) {
        if (sawCompletedOnce) {
          console.log(`      [POLL] GetExpSearch re-confirmed Completed: "True" on a follow-up poll after ${attempts + 1} attempt(s) — trusting the aggregated result.`);
          break;
        }
        console.log('      [POLL] GetExpSearch reported Completed: "True" — confirming with one more poll before trusting it.');
        sawCompletedOnce = true;
        attempts++;
        if (attempts < maxAttempts) {
          await new Promise(r => setTimeout(r, delayMs));
        }
        continue;
      }

      // A non-completed poll after a prior Completed:"True" means that first signal was itself
      // the race this guards against (flickered back to unresolved) — reset and keep polling
      // normally rather than treating it as confirmed.
      sawCompletedOnce = false;

      attempts++;
      if (attempts < maxAttempts) {
        console.log(`      [POLL] GetExpSearch not completed yet. Waiting ${delayMs}ms before retry...`);
        await new Promise(r => setTimeout(r, delayMs));
      }
    }

    if (finalResponse && aggregatedTrips) {
      finalResponse.data.Trips = aggregatedTrips;
    }

    const searchCompleted =
      finalResponse?.data?.Completed === 'True' || finalResponse?.data?.Completed === true;
    const journeyCount = (aggregatedTrips || [])
      .reduce((n, trip) => n + ((trip.Journey || []).length), 0);

    return { finalResponse, aggregatedTrips, searchCompleted, journeyCount };
  }

  /**
   * Count journeys genuinely matching a given base-carrier code, across all trips/legs.
   * Mirrors validators/availability/availabilityValidator.js's own MAC/VAC/flightNo matching
   * convention (kept in sync manually — both exist because this one runs mid-poll, before a
   * validator ever sees the response) so "does carrier X have real availability" means the same
   * thing whether the engine asks it (for date-retry) or a validator does (for pass/fail).
   * @param {Array} aggregatedTrips
   * @param {string} expectedAirline - already resolved via airlineResolver.baseCarrier()
   * @returns {number}
   * @private
   */
  _countMatchingJourneys(aggregatedTrips, expectedAirline) {
    if (!expectedAirline) return 0;
    let count = 0;
    (aggregatedTrips || []).forEach(trip => {
      (trip.Journey || []).forEach(journey => {
        const macIdentity = airlineResolver.baseCarrier((journey.MAC || '').toUpperCase().trim());
        const vacIdentity = airlineResolver.baseCarrier((journey.VAC || journey.OAC || '').toUpperCase().trim());
        const flightNo = (journey.FlightNo || '').toUpperCase().trim();
        if (macIdentity.includes(expectedAirline) || vacIdentity.includes(expectedAirline) || flightNo.startsWith(expectedAirline)) {
          count++;
        }
      });
    });
    return count;
  }

  /**
   * Shift a `YYYY-MM-DD` date string by N days. Pure UTC arithmetic on the already-resolved
   * string (scenarios/generator.js's `{{futureDate:N}}` produces exactly this format), so a
   * retry date is always the original date + N calendar days regardless of local timezone.
   * Returns null for anything that is not a plain YYYY-MM-DD date.
   * @private
   */
  _shiftDate(dateStr, days) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr ?? '').trim());
    if (!m) return null;
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().split('T')[0];
  }

  /**
   * Clone an ExpressSearch step with every trip date shifted forward by `days`.
   *
   * The clone is always derived from the PRISTINE step, so offsets are measured from the
   * original date (+2, +4, ...) and never compound. Both legs of a round trip shift by the
   * same amount, so the original onward→return gap is preserved. `days === 0` yields an
   * unmodified copy, used to report the original dates.
   *
   * The retry search is a cold search (`TUI: ""`), exactly like a domestic-multicity leg:
   * the session TUI the first ExpressSearch used has already been consumed, so a fresh one
   * must be minted for the new date.
   *
   * @returns {{step:Object, dates:string[]}|null} null when the step carries no shiftable date.
   * @private
   */
  _searchStepWithShiftedDates(searchStep, days) {
    const clone = JSON.parse(JSON.stringify(searchStep));
    const req = clone.request || clone;

    let body = req.body || req.payload;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (_) { return null; }
    }
    if (!body || !Array.isArray(body.Trips)) return null;

    const dates = [];
    body.Trips.forEach(trip => {
      ['OnwardDate', 'ReturnDate', 'Date'].forEach(key => {
        const shifted = this._shiftDate(trip[key], days);
        if (shifted !== null) {
          trip[key] = shifted;
          dates.push(shifted);
        }
      });
    });
    if (dates.length === 0) return null;

    if (days !== 0) body.TUI = '';

    if (req.body !== undefined) req.body = body; else req.payload = body;
    clone.name = days === 0 ? clone.name : `${searchStep.name} (date retry +${days}d)`;

    return { step: clone, dates };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Placeholder resolution
  // ─────────────────────────────────────────────────────────────────────────

  _resolvePlaceholders(obj, context) {
    if (obj === null || obj === undefined) return obj;
    if (typeof obj === 'string') {
      // If the string is EXACTLY a single placeholder, resolve it preserving type (number, boolean)
      const match = obj.match(/^\{\{([^}]+)\}\}$/);
      if (match) {
        const key = match[1];
        if (Object.prototype.hasOwnProperty.call(context, key)) {
          const val = context[key];
          console.log(`        [RESOLVE STRICT] {{${key}}} -> (context: ${typeof val})`);
          if (typeof val === 'string' && /^\d+$/.test(val)) {
            return Number(val);
          }
          return val;
        }
        if (key in process.env) {
          const envVal = process.env[key];
          console.log(`        [RESOLVE STRICT] {{${key}}} -> (env)`);
          if (/^\d+$/.test(envVal)) {
            return Number(envVal);
          }
          if (envVal === 'true') return true;
          if (envVal === 'false') return false;
          return envVal;
        }
      }
      return obj.includes('{{') ? this._replaceString(obj, context) : obj;
    }
    if (Array.isArray(obj)) return obj.map(item => this._resolvePlaceholders(item, context));
    if (typeof obj === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(obj)) {
        // Skip internal metadata keys
        if (k.startsWith('_')) { out[k] = v; continue; }
        out[k] = this._resolvePlaceholders(v, context);
      }
      return out;
    }
    return obj;
  }

  _replaceString(str, context) {
    const resolved = str.replace(/\{\{(.+?)\}\}/g, (match, p1) => {
      // 1. Data generator (futureDate, uuid, randomEmail)
      const generated = dataGenerator.resolve(`{{${p1}}}`);
      if (generated !== `{{${p1}}}`) {
        console.log(`        [RESOLVE] {{${p1}}} -> (generated)`);
        return generated;
      }
      // 2. Context (variables saved from previous steps)
      if (Object.prototype.hasOwnProperty.call(context, p1)) {
        console.log(`        [RESOLVE] {{${p1}}} -> (context)`);
        return context[p1];
      }
      // 3. Environment (.env file)
      if (p1 in process.env) {
        console.log(`        [RESOLVE] {{${p1}}} -> (env)`);
        return process.env[p1];
      }
      // 4. Fail fast
      console.error(`        [MISSING] {{${p1}}} (context: ${Object.keys(context).join(', ')})`);
      throw new Error(`Placeholder missing value: ${p1}`);
    });
    // Recurse if nested placeholders remain
    return resolved !== str && resolved.includes('{{') ? this._replaceString(resolved, context) : resolved;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Poll aggregation
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Identity of a single journey row, used to dedupe across GetExpSearch polls.
   *
   * NOT JourneyKey: that encodes only the flight (carrier, number, route, times) and
   * carries no fare identity, so every fare option on a flight — and, for RS, every
   * package built on it — collapses to one row. On a live BOM-DEL RS search, 75 distinct
   * packages shared a single JourneyKey.
   *
   * A row is uniquely identified by its provider, its fare Index, and — for RS packages —
   * its ReturnIdentifier, since the same fare on the same flight appears once per package.
   */
  _journeyIdentity(journey) {
    const provider = journey.Provider ?? '';
    const retId    = Number(journey.ReturnIdentifier ?? 0);

    if (journey.Index) return `${provider}|${journey.Index}|${retId}`;

    // Index is the provider's own fare handle; if it is ever absent, fall back to the
    // flight plus enough fare detail to keep distinct fares apart.
    const carrier = journey.VAC || journey.MAC || '';
    return [
      provider, carrier, journey.FlightNo, journey.DepartureTime,
      journey.FCType, journey.FareClass, journey.NetFare, retId
    ].join('|');
  }

  /**
   * For a COMBINED itinerary (international multicity), returns the set of Trips[0] Indexes that
   * are actually combinable across the whole trip — i.e. present on every leg. The provider lists
   * many priced fares on the lead leg, but only those whose Index also appears on all later legs
   * form a bookable package; selecting any other (e.g. a cheaper IndiGo product that only exists on
   * leg 1) prices at SmartPricer but is rejected by GetSPricer with "non combinable product class".
   *
   * Returns null when the response is not a combined itinerary (single leg, or later legs carry
   * their own independent fares as in a round trip), so normal selection is left untouched.
   */
  _combinableIndexes(response) {
    const trips = response?.data?.Trips;
    if (!Array.isArray(trips) || trips.length < 2) return null;

    // A combined itinerary's later legs price at 0 and reuse the lead leg's Index.
    const laterLegsAreZeroFare = trips.slice(1).every(t =>
      (t.Journey || []).length > 0 && (t.Journey || []).every(j => !(Number(j.NetFare) > 0))
    );
    if (!laterLegsAreZeroFare) return null;

    const indexesOnLeg = t => new Set((t.Journey || []).map(j => j.Index));
    let combinable = indexesOnLeg(trips[0]);
    for (let i = 1; i < trips.length; i++) {
      const here = indexesOnLeg(trips[i]);
      combinable = new Set([...combinable].filter(ix => here.has(ix)));
    }
    return combinable.size > 0 ? combinable : null;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Variable extraction (standard lodash paths)
  // ─────────────────────────────────────────────────────────────────────────

  _resolveConditionalPath(response, pathExpr) {
    if (typeof pathExpr !== 'string') return pathExpr;

    // Pattern to match array filters with quoted or unquoted values: Journey[FCType="STRETCH+ BUSINESS"]
    const regex = /(\w+)\[(\w+)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\]]+))\]/g;
    
    let resolvedPath = pathExpr;
    let match;
    
    while ((match = regex.exec(pathExpr)) !== null) {
      const [fullMatch, arrayName, fieldName, doubleQuoteValue, singleQuoteValue, noQuoteValue] = match;
      const targetValue = doubleQuoteValue || singleQuoteValue || noQuoteValue;
      
      const arrayPathIdx = resolvedPath.indexOf(fullMatch);
      if (arrayPathIdx === -1) continue;
      
      const beforePart = resolvedPath.substring(0, arrayPathIdx) + arrayName;
      const arr = _.get({ response }, beforePart);
      
      if (Array.isArray(arr)) {
        let index = -1;

        // Roundtrip return-leg pairing for Trips[1].Journey.
        //
        // Two distinct fare products come back from the provider:
        //   RT (normal)         — ReturnIdentifier === 0. Legs are priced independently and
        //                         combine freely, so the return leg is chosen by the step's
        //                         own fare filter (standard matching below).
        //   RS (Return Special) — ReturnIdentifier  >  0. The provider returns a fixed
        //                         onward+return package; the return leg is already mapped to
        //                         its onward and must be looked up, never re-chosen.
        //
        // The package key is Index: the paired onward and return rows of one RS package carry
        // the SAME Index (e.g. "6E|37" on both legs). ReturnIdentifier is a COARSER grouping —
        // one identifier spans many packages, which is what lets the portal show a set of
        // mappable returns once an onward is picked. Measured on a live marketplace RS search
        // (3,273 onward rows): Index resolved 3,072 onwards to exactly one return with ZERO
        // ambiguity, while Provider+ReturnIdentifier left 3,048 ambiguous and picked zero-fare
        // placeholder rows. Provider is kept in the key defensively; Index already embeds it.
        if (beforePart.includes('Trips[1].Journey') && response?.data?.Trips?.[0]?.Journey) {
          const onwardJourneyList = response.data.Trips[0].Journey;

          const matchesFare = item => {
            const val = _.get(item, fieldName);
            return typeof val === 'string'
              ? val.toLowerCase().includes(targetValue.toLowerCase())
              : String(val) === String(targetValue);
          };
          const resolvesToReturn = onward => arr.findIndex(item =>
            item.Index === onward.Index && item.Provider === onward.Provider
          );

          // Candidate onwards, ordered the same way Trips[0] selection orders them: the fare
          // filter first, then a real bookable fare ahead of zero-fare placeholder rows.
          const candidates = onwardJourneyList
            .filter(j => matchesFare(j) && Number(j.ReturnIdentifier ?? 0) > 0)
            .sort((a, b) => (Number(b.NetFare) > 0 ? 1 : 0) - (Number(a.NetFare) > 0 ? 1 : 0));

          if (candidates.length > 0) {
            // Providers can return dangling onward rows whose return leg they never sent
            // (observed: S6E, 12 of 1,774 packages in one live search). Those packages are not
            // bookable, so skip to the next candidate that actually resolves rather than
            // failing the scenario on the provider's own data noise.
            const selectedOnward = candidates.find(o => resolvesToReturn(o) !== -1);

            if (!selectedOnward) {
              const first = candidates[0];
              throw new Error(
                `No bookable RS package for fare "${targetValue}": all ${candidates.length} matching ` +
                `onward journey(s) reference a return leg the provider did not return ` +
                `(e.g. Provider="${first.Provider}" Index="${first.Index}", ` +
                `onward ${first.MAC}${first.FlightNo})`
              );
            }

            index = resolvesToReturn(selectedOnward);
            const skipped = candidates.indexOf(selectedOnward);
            console.log(`        [ROUNDTRIP RS-PAIRING] Paired return journey at index ${index} via ` +
              `Index="${selectedOnward.Index}" (Provider=${selectedOnward.Provider})` +
              (skipped > 0 ? ` — skipped ${skipped} dangling package(s)` : ''));
          }
        }

        // Fallback to standard index matching
        if (index === -1) {
          const matchIndices = [];
          arr.forEach((item, i) => {
            const val = _.get(item, fieldName);
            const isMatch = typeof val === 'string'
              ? val.toLowerCase().includes(targetValue.toLowerCase())
              : String(val) === String(targetValue);
            if (isMatch) matchIndices.push(i);
          });

          // On the lead leg of a combined itinerary (international multicity), the fare must be
          // both structurally combinable (Index present on every leg) AND a genuinely combinable
          // product. Verified on the live API: GetSPricer accepts consolidator-assembled
          // itineraries (Provider "SB"/"1G" marketing real per-leg carriers — Emirates, Malaysia,
          // Air India) and rejects an LCC self-quote (IndiGo Provider "6E" claiming legs it does
          // not operate) with "non combinable product class". So among combinable candidates,
          // prefer a consolidator booking (Provider differs from the leg's marketing carrier) over
          // a carrier self-quote, then the cheapest. Left untouched for non-combined responses.
          //
          // Provider !== MAC alone isn't enough: a carrier's own NDC channel offer also shows a
          // distinct Provider (e.g. Star Air's NDC offer is "S51" vs its MAC "S5") without being a
          // third-party consolidator. Resolve Provider through the airline registry's `parent`
          // mapping (the same one that maps IndiGo's C6E/E6E/S6E channel codes back to 6E) so a
          // same-carrier channel code isn't misclassified as a consolidator.
          const combinable = (beforePart.includes('Trips[0].Journey'))
            ? this._combinableIndexes(response)
            : null;
          const isConsolidated = item =>
            !!item.Provider && !!item.MAC && item.Provider !== item.MAC &&
            airlineResolver.baseCarrier(item.Provider) !== item.MAC;
          const rank = i => (combinable && !isConsolidated(arr[i]) ? 1 : 0); // 0 = preferred
          // For a combined itinerary the requested fare product ("SAVER") is irrelevant — the
          // combinable consolidator fares are labelled PUBLISHED / NDC-ECOSAVER, so consider every
          // combinable journey, not just the FCType matches.
          const eligible = combinable
            ? arr.map((_item, i) => i).filter(i => combinable.has(arr[i].Index))
            : matchIndices;

          if (combinable) {
            // Choose the best combinable priced candidate: consolidator first, then cheapest.
            let best = -1;
            eligible.forEach(i => {
              if (!(Number(arr[i].NetFare) > 0)) return;
              if (best === -1) { best = i; return; }
              const better = rank(i) - rank(best) || (Number(arr[i].NetFare) - Number(arr[best].NetFare));
              if (better < 0) best = i;
            });
            index = best !== -1 ? best : (eligible.length ? eligible[0] : (matchIndices.length ? matchIndices[0] : -1));
          } else {
            // Standard (non-combined) selection: prefer the first bookable fare, else — for an
            // FCType filter whose matches are all unpriced — the cheapest genuinely bookable fare
            // (some products, e.g. NDC-ECOSAVER, don't carry the default "SAVER").
            const bookableIndex = matchIndices.find(i => Number(arr[i].NetFare) > 0);
            if (bookableIndex !== undefined) {
              index = bookableIndex;
            } else if (fieldName === 'FCType') {
              let cheapest = -1;
              arr.forEach((item, i) => {
                const net = Number(item.NetFare);
                if (net > 0 && (cheapest === -1 || net < Number(arr[cheapest].NetFare))) cheapest = i;
              });
              index = cheapest !== -1 ? cheapest : (matchIndices.length ? matchIndices[0] : -1);
            } else {
              index = matchIndices.length ? matchIndices[0] : -1;
            }
          }
        }
        
        const replacement = index !== -1 ? `${arrayName}[${index}]` : `${arrayName}[0]`;
        resolvedPath = resolvedPath.replace(fullMatch, replacement);
      } else {
        resolvedPath = resolvedPath.replace(fullMatch, `${arrayName}[0]`);
      }
    }
    
    return resolvedPath;
  }

  /**
   * Convert the dedicated Flights/SSR response into the shape CreateItinerary's
   * own `SSR` field expects — verified against a live captured CreateItinerary
   * request/response pair: `[{FUID, PaxID, SSID, SSRType}]`, where `SSID` is the
   * segment SSR entry's own `ID` field (NOT the GetSPricer top-level SSR[]'s
   * `Code`) and `SSRType` is that same entry's `Type`. Only entries with
   * Charge > 0 are "selected" (a purchasable option actually being bought); a
   * free-SSR request (all Charge 0, or a failed/empty SSR call) naturally
   * yields an empty selection and a zero SSRAmount.
   *
   * Domestic multicity's per-leg flow (5.1.SSR_Leg{N}) carries `_legIndex` and every other
   * context var it saves is `_${legIndex}`-suffixed (Trips_0, SSR_0, FinalAmount_0, ...) — this
   * writes SelectedSSR_{legIndex}/SelectedSSRAmount_{legIndex} to match, so CreateItinerary_Leg{N}
   * picks up that same leg's own selection rather than an unindexed variable another leg's SSR
   * call could equally have written.
   */
  _extractSelectedSSR(response, context, legIndex) {
    const trips = response?.data?.Trips;
    // One selection per SSRType per segment — a passenger picks a single meal, a single baggage
    // tier, etc.; the options within one category are mutually-exclusive alternatives, not
    // additive. Verified live: naively including every Charge > 0 entry (every meal AND every
    // baggage tier offered) inflated a single COK-BLR domestic RT 6E scenario's SSRAmount to
    // Rs 264,269 across 40 entries (8 meal + 11 baggage-tier options, per segment). Picks the
    // cheapest paid option per (FUID, Type).
    const bestByKey = new Map();

    if (Array.isArray(trips)) {
      trips.forEach(trip => {
        (trip.Journey || []).forEach(journey => {
          if (!journey) return;
          (journey.Segments || []).forEach(seg => {
            const fuid = Number(seg.FUID ?? seg?.Flight?.FUID ?? 1);
            (seg.SSR || []).forEach(ssr => {
              const charge = Number(ssr.Charge) || 0;
              if (charge <= 0) return;
              const type = Number(ssr.Type);
              const key = `${fuid}|${type}`;
              const existing = bestByKey.get(key);
              if (!existing || charge < existing.charge) {
                bestByKey.set(key, { FUID: fuid, PaxID: 1, SSID: ssr.ID, SSRType: type, charge });
              }
            });
          });
        });
      });
    }

    let totalCharge = 0;
    const selected = [...bestByKey.values()].map(({ FUID, PaxID, SSID, SSRType, charge }) => {
      totalCharge += charge;
      return { FUID, PaxID, SSID, SSRType };
    });

    const selectedKey = legIndex !== undefined ? `SelectedSSR_${legIndex}` : 'SelectedSSR';
    const amountKey = legIndex !== undefined ? `SelectedSSRAmount_${legIndex}` : 'SelectedSSRAmount';
    context[selectedKey] = selected;
    context[amountKey] = totalCharge;
    console.log(`      [SAVED] ${selectedKey} = ${JSON.stringify(selected)}`);
    console.log(`      [SAVED] ${amountKey} = ${totalCharge}`);
  }

  _extractVariables(saveRules, response, context) {
    if (!saveRules) return;
    for (const [varName, rawPathExpr] of Object.entries(saveRules)) {
      const pathExpr = this._resolveConditionalPath(response, rawPathExpr);
      
      // Special computed paths (e.g. Provider|FUID|Cabin)
      if (pathExpr.includes('|')) {
        const parts = pathExpr.split('|').map(p => _.get({ response }, p.trim()) ?? p);
        context[varName] = parts.join('|');
        console.log(`      [SAVED] ${varName} = ${context[varName]}`);
        continue;
      }
      const value = _.get({ response }, pathExpr);
      if (value === undefined) {
        console.warn(`      [WARN] Could not extract ${varName} via path: ${pathExpr} (original: ${rawPathExpr})`);
        context[varName] = null;
      } else {
        context[varName] = value;
        const display = typeof value === 'string' && value.length > 25
          ? value.substring(0, 25) + '...' : value;
        console.log(`      [SAVED] ${varName} = ${display}`);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Computed expressions (template strings referencing response fields)
  // ─────────────────────────────────────────────────────────────────────────

  _computeExpressions(expressions, response, context) {
    if (!expressions) return;
    for (const [varName, template] of Object.entries(expressions)) {
      const value = template.replace(/\{\{([\w.[\]"=\s'-]+)\}\}/g, (m, path) => {
        const resolvedPath = this._resolveConditionalPath(response, path);
        return _.get({ response }, resolvedPath) ?? '';
      });
      context[varName] = value;
      console.log(`      [COMPUTED] ${varName} = ${value}`);
    }
  }
}

module.exports = new Executor();
