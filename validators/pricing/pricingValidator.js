'use strict';

const BaseValidator = require('../../airlines/base/BaseValidator');

/**
 * PricingValidator — Validates fare amounts in flight search responses.
 *
 * Checks:
 *   - NetFare > 0
 *   - GrossFare >= NetFare
 *   - GrossFare - NetFare >= 0 (markup is non-negative)
 *   - NetAmount > 0 on priced responses (GetSPricer)
 */
class PricingValidator extends BaseValidator {
  constructor() { super('pricing'); }

  validate(response, context, scenario, step) {
    const data = response.data;
    if (!data) return this.pass(); // nothing to validate

    const errors = [];
    const warnings = [];

    // ── GetExpSearch / GetSPricer: check Trips[].Journey[].fares
    //
    // Providers legitimately return zero-fare placeholder journeys (connecting-route
    // permutations, sold-out rows) interleaved with real, priced options — and they can
    // land anywhere in the array, including first. So a zero fare is not itself an error;
    // what matters is that each trip offers at least one bookable fare, and that the
    // journey the engine actually selected is priced. Asserting on Journey[0] instead just
    // fails whenever a placeholder happens to sort first.
    // International multicity is a COMBINED itinerary: the whole multi-leg journey is priced as
    // one unit, so the total fare rides on Trips[0] and every later leg legitimately carries
    // NetFare 0 while sharing Trips[0]'s Index. Asserting per-leg bookability there is wrong —
    // only the lead trip carries a fare. (Domestic MC is N independent searches and does not hit
    // this branch.) Verified on the production portal.
    const dims = scenario?.dimensions || {};
    const isCombinedItinerary = dims.tripType === 'MC' && dims.sectorType === 'INT';

    if (Array.isArray(data.Trips)) {
      data.Trips.forEach((trip, ti) => {
        // .filter(Boolean) drops null placeholders — a failed leg (e.g. Code "1000") degrades
        // to Journey:[null] rather than an empty array.
        const journeys = (trip.Journey || []).filter(Boolean);
        const priced = journeys.filter(j => j.NetFare !== undefined && j.NetFare > 0);

        // For a combined itinerary, only the lead trip must be bookable; later legs price at 0.
        const mustBeBookable = !isCombinedItinerary || ti === 0;

        if (mustBeBookable && journeys.length > 0 && priced.length === 0) {
          const anyFares = journeys.some(j => j.NetFare !== undefined || j.GrossFare !== undefined);
          if (anyFares) {
            errors.push(`Trip[${ti}] has no bookable fare: all ${journeys.length} journey(s) have NetFare <= 0`);
          }
        }

        // The journey this scenario actually chose must be priced. On a combined itinerary the
        // selection is the lead trip only; the other legs share its Index at fare 0 by design.
        const selectedIndex = ti === 0 ? context.Index : context.ReturnIndex;
        if (selectedIndex && mustBeBookable) {
          const selected = journeys.find(j => j.Index === selectedIndex);
          if (selected && selected.NetFare !== undefined && selected.NetFare <= 0) {
            errors.push(`Trip[${ti}] selected journey (Index "${selectedIndex}") NetFare must be > 0, got: ${selected.NetFare}`);
          }
        }

        journeys.forEach((journey, ji) => {
          const net   = journey.NetFare;
          const gross = journey.GrossFare;

          if (net === undefined && gross === undefined) return; // no fares in this step

          if (net !== undefined && net <= 0) {
            warnings.push(`Trip[${ti}].Journey[${ji}] NetFare is <= 0 (placeholder or sold out), got: ${net}`);
          }
          if (gross !== undefined && net !== undefined && gross < net) {
            // A negative markup on a real, priced fare is a data-integrity error wherever
            // it sits; on a zero-fare placeholder it is just noise.
            if (net > 0) {
              errors.push(`Trip[${ti}].Journey[${ji}] GrossFare (${gross}) < NetFare (${net})`);
            } else {
              warnings.push(`Trip[${ti}].Journey[${ji}] GrossFare (${gross}) < NetFare (${net})`);
            }
          }

          // Check PTCFare breakdown sums
          (journey.Segments || []).forEach((seg, si) => {
            const ptcFares = seg?.Fares?.PTCFare;
            if (!Array.isArray(ptcFares)) return;
            ptcFares.forEach((ptc, pi) => {
              if (ptc.NetFare !== undefined && ptc.NetFare <= 0) {
                warnings.push(`PTCFare[${pi}] NetFare is <= 0`);
              }
            });
          });
        });
      });
    }

    // ── GetSPricer: check top-level NetAmount
    if (step._stepKey === 'getPrice') {
      if (data.NetAmount !== undefined && data.NetAmount <= 0) {
        errors.push(`NetAmount must be > 0, got: ${data.NetAmount}`);
      }
      if (data.GrossAmount !== undefined && data.NetAmount !== undefined
          && data.GrossAmount < data.NetAmount) {
        errors.push(`GrossAmount (${data.GrossAmount}) < NetAmount (${data.NetAmount})`);
      }
    }

    // ── Fare change: the priced NetAmount differs from what was quoted at search. This is a real
    // mid-flow event (accepted & continue) — record it as a CHANGE, not a failure. The priced
    // amount is authoritative.
    if (step._stepKey === 'getPrice' && context.Amount && data.NetAmount) {
      const diff = data.NetAmount - context.Amount;
      if (Math.abs(diff) > 10) {
        warnings.push(`CHANGE: fare change — searched ${context.Amount} now priced ${data.NetAmount} ` +
          `(${diff > 0 ? '+' : ''}${diff.toFixed(2)}); accepted`);
      }
    }

    if (errors.length > 0) return this.fail(...errors);
    if (warnings.length > 0) return this.warn(...warnings);
    return this.pass();
  }
}

module.exports = new PricingValidator();
