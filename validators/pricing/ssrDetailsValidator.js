'use strict';

const BaseValidator = require('../../airlines/base/BaseValidator');

/**
 * SsrDetailsValidator — validates the response of the dedicated Flights/SSR
 * call (step._stepKey === 'ssr'), NOT the SSR[] array embedded in GetSPricer
 * (that is covered separately by ssrValidator / 6E_baggage).
 *
 * Free SSR (request PaidSSR: false) returns the fare's included baggage
 * allowance — every entry must have Charge 0.
 * Paid SSR (request PaidSSR: true) returns purchasable extra-baggage options
 * (codes like EBxx/IBxx, not just BAG) — every entry must have Charge > 0.
 *
 * Baggage (Type "2") is a whole-JOURNEY charge, not a per-segment one — an airline charges
 * excess baggage once for a connecting itinerary (verified live: on a connecting SG return leg,
 * the paid baggage option — Code IB08, Charge 1600 — appeared only on the first segment's SSR[],
 * with the second (connecting) segment's own SSR[] entries all at Charge 0 by design, not because
 * no paid option was offered). So a baggage entry only needs Charge > 0 SOMEWHERE across the
 * journey's segments, not on every individual one. Meals and other per-segment SSR types (Type
 * "1", etc.) are genuinely independent per segment — a passenger can choose a meal on one
 * connecting leg and not another — so those still need their own Charge > 0 on every segment.
 */
class SsrDetailsValidator extends BaseValidator {
  constructor() { super('ssrDetails'); }

  validate(response, context, scenario, step) {
    if (step._stepKey !== 'ssr') return this.pass();

    const data = response.data;
    if (!data || !Array.isArray(data.Trips)) {
      return this.warn('SSR response missing Trips[] — baggage check skipped');
    }
    // A failed SSR lookup (e.g. Code "1000" "Failed") degrades to Journey:[null]
    // rather than an empty array — a real live shape, not malformed test data.
    if (data.Code && String(data.Code) !== '200') {
      return this.warn(`SSR call did not succeed (Code ${data.Code}, Msg: ${(data.Msg || []).join(', ')}) — baggage check skipped`);
    }

    const paidSSR = data.PaidSSR === true;
    const errors = [];
    let totalEntries = 0;

    data.Trips.forEach((trip, tIdx) => {
      (trip.Journey || []).forEach((journey, jIdx) => {
        if (!journey) return;
        const segments = journey.Segments || [];
        const baggageEntries = [];

        segments.forEach((segment, sIdx) => {
          (segment.SSR || []).forEach((ssr, ssrIdx) => {
            totalEntries++;
            const label = `Trips[${tIdx}].Journey[${jIdx}].Segments[${sIdx}].SSR[${ssrIdx}]`;

            if (!ssr.Description) {
              errors.push(`${label} is missing Description`);
            }
            if (ssr.Charge === undefined || ssr.Charge === null) {
              errors.push(`${label} is missing Charge field`);
              return;
            }

            if (String(ssr.Type) === '2') {
              baggageEntries.push({ ssr, label });
              return; // checked at journey level below, not per-segment
            }

            if (paidSSR && !(ssr.Charge > 0)) {
              errors.push(`${label} expected Charge > 0 for paid SSR, got ${ssr.Charge}`);
            }
            if (!paidSSR && ssr.Charge !== 0) {
              errors.push(`${label} expected Charge 0 for free SSR, got ${ssr.Charge}`);
            }
          });
        });

        if (baggageEntries.length === 0) return;

        if (paidSSR) {
          const hasPaidBaggage = baggageEntries.some(({ ssr }) => ssr.Charge > 0);
          if (!hasPaidBaggage) {
            errors.push(`Trips[${tIdx}].Journey[${jIdx}]: no baggage (Type 2) SSR entry across its ` +
              `${segments.length} segment(s) has Charge > 0 for paid SSR`);
          }
        } else {
          baggageEntries.forEach(({ ssr, label }) => {
            if (ssr.Charge !== 0) {
              errors.push(`${label} expected Charge 0 for free SSR, got ${ssr.Charge}`);
            }
          });
        }
      });
    });

    if (totalEntries === 0) {
      return this.warn('No SSR entries found in Flights/SSR response');
    }

    return errors.length > 0 ? this.fail(...errors) : this.pass();
  }
}

module.exports = new SsrDetailsValidator();
