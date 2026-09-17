'use strict';

const BaseValidator = require('../../airlines/base/BaseValidator');

/**
 * ItineraryValidator — Reconciles the CreateItinerary call against the request
 * it was built from and the fare it was priced against. Verified against a
 * live captured CreateItinerary request/response pair.
 *
 * Checks:
 *   1. NetAmount reconciliation — CreateItinerary's own NetAmount must equal
 *      AirlineNetFare + SSRAmount (its two internal components), and the
 *      request's NetAmount + SSRAmount (what was submitted) must match what
 *      came back.
 *   2. TransactionID was actually generated (the itinerary was created).
 *   3. The booked Trip/journey's flight identity (FlightNo per leg) matches
 *      what GetSPricer priced (context.Trips), not some other flight.
 *   4. Every SSR line item submitted in the request is reflected as a paid
 *      (Charge > 0) entry in the response's SSR[] for the same FUID.
 */
class ItineraryValidator extends BaseValidator {
  constructor() { super('itinerary'); }

  validate(response, context, scenario, step) {
    if (step._stepKey !== 'createItinerary') return this.pass();

    const data = response.data;
    if (!data) return this.fail('CreateItinerary response body is empty');

    const errors = [];

    const rawReqBody = response.config?.data;
    let request = {};
    if (typeof rawReqBody === 'string') {
      try { request = JSON.parse(rawReqBody); } catch (_) { /* leave empty */ }
    } else if (rawReqBody) {
      request = rawReqBody;
    }

    // ── 1. NetAmount reconciliation
    const resNetAmount = Number(data.NetAmount);
    const resAirlineNetFare = Number(data.AirlineNetFare);
    const resSSRAmount = Number(data.SSRAmount);
    if (![resNetAmount, resAirlineNetFare, resSSRAmount].some(Number.isNaN)) {
      const composed = resAirlineNetFare + resSSRAmount;
      if (Math.abs(resNetAmount - composed) > 1) {
        errors.push(`NetAmount (${resNetAmount}) does not equal AirlineNetFare + SSRAmount ` +
          `(${resAirlineNetFare} + ${resSSRAmount} = ${composed})`);
      }
    }

    const reqNetAmount = Number(request.NetAmount);
    const reqSSRAmount = Number(request.SSRAmount);
    if (!Number.isNaN(reqNetAmount) && !Number.isNaN(reqSSRAmount) && !Number.isNaN(resNetAmount)) {
      const requestedTotal = reqNetAmount + reqSSRAmount;
      if (Math.abs(resNetAmount - requestedTotal) > 10) {
        errors.push(`Requested total (NetAmount ${reqNetAmount} + SSRAmount ${reqSSRAmount} = ` +
          `${requestedTotal}) does not match CreateItinerary's NetAmount (${resNetAmount})`);
      }
    }

    // ── 2. TransactionID generated
    if (!data.TransactionID) {
      errors.push(`No TransactionID generated in CreateItinerary response (got: ${JSON.stringify(data.TransactionID)})`);
    }

    // ── 3. Booked trip/journey matches what was priced (GetSPricer's saved Trips)
    //
    // Domestic multicity's per-leg flow (CreateItinerary_Leg{N}, carrying _legIndex) saves
    // everything leg-indexed (Trips_{legIndex}, Index_{legIndex}) rather than the unindexed
    // Trips/Index/ReturnIndex the single OW/RT flow uses — and has exactly one trip per leg's
    // own CreateItinerary call, never a return leg.
    const legIndex = step._legIndex;
    const pricedTrips = legIndex !== undefined ? context[`Trips_${legIndex}`] : context.Trips;
    if (Array.isArray(pricedTrips) && Array.isArray(data.Trips)) {
      pricedTrips.forEach((pricedTrip, ti) => {
        const bookedTrip = data.Trips[ti];
        if (!bookedTrip) {
          errors.push(`Trip[${ti}]: priced but missing from CreateItinerary response`);
          return;
        }

        // International multicity is a COMBINED itinerary: every trip shares Trips[0]'s one
        // Index (no ReturnIndex is ever saved for it, unlike genuine roundtrip) — verified live
        // on a 2-sector INT MC (BOM-DXB-LHR): Trip[1]'s own journeys all price at NetFare 0, so
        // falling back to "first NetFare > 0" finds nothing and would blindly pick
        // priceableJourneys[0] instead of the journey actually sharing the booked Index.
        const selectedIndex = legIndex !== undefined
          ? context[`Index_${legIndex}`]
          : (ti === 0 ? context.Index : (context.ReturnIndex || context.Index));
        const priceableJourneys = (pricedTrip.Journey || []).filter(Boolean);
        const pricedJourney = (selectedIndex && priceableJourneys.find(j => j.Index === selectedIndex))
          || priceableJourneys.find(j => Number(j.NetFare) > 0)
          || priceableJourneys[0];
        const bookedJourney = (bookedTrip.Journey || []).filter(Boolean)[0];

        const pricedLegs = this._segmentsOf(pricedJourney);
        const bookedLegs = this._segmentsOf(bookedJourney);

        if (pricedLegs.length === 0 || bookedLegs.length === 0) return;

        if (pricedLegs.length !== bookedLegs.length) {
          errors.push(`Trip[${ti}]: leg count mismatch — priced ${pricedLegs.length}, booked ${bookedLegs.length}`);
          return;
        }

        pricedLegs.forEach((pLeg, li) => {
          const pFlight = pLeg.Flight || pLeg;
          const bFlight = bookedLegs[li].Flight || bookedLegs[li];
          const pFlightNo = String(pFlight.FlightNo || '').trim();
          const bFlightNo = String(bFlight.FlightNo || '').trim();
          if (pFlightNo !== bFlightNo) {
            errors.push(`Trip[${ti}].Leg[${li}] FlightNo mismatch: priced="${pFlightNo}" booked="${bFlightNo}"`);
          }
        });
      });
    }

    // ── 4. Requested SSR reflected in the response
    const requestedSSR = Array.isArray(request.SSR) ? request.SSR : [];
    if (requestedSSR.length > 0) {
      const responseSSR = Array.isArray(data.SSR) ? data.SSR : [];
      const byFUID = new Map();
      responseSSR.forEach(s => {
        const fuid = String(s.FUID);
        if (!byFUID.has(fuid)) byFUID.set(fuid, []);
        byFUID.get(fuid).push(s);
      });

      requestedSSR.forEach(reqSSR => {
        const fuid = String(reqSSR.FUID);
        const candidates = byFUID.get(fuid) || [];
        const matched = candidates.some(c => Number(c.Charge) > 0);
        if (!matched) {
          errors.push(`Requested SSR (FUID ${fuid}, SSID ${reqSSR.SSID}) is not reflected as a paid ` +
            `entry in CreateItinerary response SSR[]`);
        }
      });
    }

    if (errors.length > 0) return this.fail(...errors);
    return this.pass('CreateItinerary reconciled: NetAmount, TransactionID, trip identity, and SSR all consistent');
  }
}

module.exports = new ItineraryValidator();
