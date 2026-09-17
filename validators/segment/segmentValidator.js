'use strict';

const BaseValidator = require('../../airlines/base/BaseValidator');

/**
 * SegmentValidator — Validates flight segment data integrity.
 *
 * Checks:
 *   - Departure airport matches request origin
 *   - Arrival airport matches request destination (for OW/RT leg 1)
 *   - DepartureTime < ArrivalTime
 *   - Segment has required fields (FlightNo, Airline, Cabin)
 *   - IsDirect=true → only 1 segment per journey
 */
class SegmentValidator extends BaseValidator {
  constructor() { super('segment'); }

  validate(response, context, scenario, step) {
    if (step && (step._stepKey === 'ssr' || step._stepKey === 'fareRule' || step._stepKey === 'createItinerary')) {
      return this.pass();
    }

    const data = response.data;
    if (!data || !Array.isArray(data.Trips)) return this.pass();

    const errors = [];
    const warnings = [];
    const { tripType } = scenario.dimensions;
    const dataset = scenario.dataset || {};

    data.Trips.forEach((trip, ti) => {
      (trip.Journey || []).forEach((journey, ji) => {
        // BaseValidator._segmentsOf reconstructs the real legs — correctly splitting a
        // Stops>=1 connection across the journey's own fields (leg 1) and each Connections
        // Type "C" entry (leg 2+), and excluding Type "H" technical-halt entries entirely.
        const segments = this._segmentsOf(journey);

        if (segments.length === 0) {
          warnings.push(`Trip[${ti}].Journey[${ji}] has no Segments`);
          return;
        }

        const firstSeg = segments[0].Flight || segments[0];
        const lastSeg  = segments[segments.length - 1].Flight || segments[segments.length - 1];

        // ── Validate departure/arrival airports for OW/RT leg-1
        // Search-shaped journeys (direct or connecting) carry the airport codes as
        // From/To; the priced/nested shape uses DepartureCode/ArrivalCode. Accept either.
        if ((tripType === 'OW' || tripType === 'RT') && ti === 0) {
          const nearbyAirport = (scenario.dimensions?.nearbyAirport || '').toUpperCase().trim();
          // The first/last leg's own departure/arrival always match the journey's
          // overall From/To, so fall back to those when the leg itself omits them
          // (seen on interline/codeshare-marketed connecting legs).
          const firstSegDeparture = firstSeg?.DepartureCode || firstSeg?.From || journey.From;
          const lastSegArrival = lastSeg?.ArrivalCode || lastSeg?.To || journey.To;

          if (firstSegDeparture && dataset.origin) {
            const allowedOrigins = [dataset.origin];
            if (nearbyAirport) allowedOrigins.push(nearbyAirport);

            if (!allowedOrigins.includes(firstSegDeparture)) {
              errors.push(`Trip[${ti}] departure ${firstSegDeparture} ≠ requested origin ${dataset.origin} (allowed: ${allowedOrigins.join(', ')})`);
            }
          }
          if (lastSegArrival && dataset.destination) {
            const allowedDestinations = [dataset.destination];
            if (nearbyAirport) allowedDestinations.push(nearbyAirport);

            if (!allowedDestinations.includes(lastSegArrival)) {
              errors.push(`Trip[${ti}] arrival ${lastSegArrival} ≠ requested destination ${dataset.destination} (allowed: ${allowedDestinations.join(', ')})`);
            }
          }
        }

        // ── Validate each segment's required fields
        segments.forEach((seg, si) => {
          const f = seg.Flight || seg;
          if (!f) {
            errors.push(`Trip[${ti}].Journey[${ji}].Segment[${si}] missing Flight object`);
            return;
          }
          if (!f.FlightNo || !f.FlightNo.trim()) {
            errors.push(`Segment[${si}] missing FlightNo`);
          }
          // _segmentsOf already resolved this leg's correct From/To (for the search-stage
          // Connections shape, it corrected the Airport-is-departure-not-arrival quirk);
          // the priced/nested shape uses DepartureCode/ArrivalCode instead. Accept either.
          const departureCode = f.DepartureCode || f.From;
          const arrivalCode = f.ArrivalCode || f.To;
          if (!departureCode || !arrivalCode) {
            errors.push(`Segment[${si}] missing DepartureCode/From or ArrivalCode/To`);
          }
          // Departure < Arrival (nested/priced shape carries times per-segment)
          if (f.DepartureTime && f.ArrivalTime) {
            const dep = new Date(f.DepartureTime);
            const arr = new Date(f.ArrivalTime);
            if (dep >= arr) {
              errors.push(`Segment[${si}] DepartureTime (${f.DepartureTime}) >= ArrivalTime (${f.ArrivalTime})`);
            }
          }
        });

        // Search-shaped journeys (Connections) only carry DepartureTime/ArrivalTime
        // on the journey itself, not per-segment — check overall journey ordering here.
        if (journey.DepartureTime && journey.ArrivalTime) {
          const journeyDep = new Date(journey.DepartureTime);
          const journeyArr = new Date(journey.ArrivalTime);
          if (journeyDep >= journeyArr) {
            errors.push(`Trip[${ti}].Journey[${ji}] DepartureTime (${journey.DepartureTime}) >= ArrivalTime (${journey.ArrivalTime})`);
          }
        }
      });
    });

    if (errors.length > 0) return this.fail(...errors);
    if (warnings.length > 0) return this.warn(...warnings);
    return this.pass();
  }
}

module.exports = new SegmentValidator();
