'use strict';

const BaseValidator = require('../../airlines/base/BaseValidator');

/**
 * RoundtripValidator — Validates roundtrip-specific response structure.
 *
 * Only activates when scenario.dimensions.tripType === 'RT'.
 * Checks:
 *   - Two journey legs present (outbound + return)
 *   - Return departure airport matches outbound arrival
 *   - Return departure date >= outbound arrival date
 */
class RoundtripValidator extends BaseValidator {
  constructor() { super('roundtrip'); }

  validate(response, context, scenario, step) {
    if (scenario.dimensions.tripType !== 'RT') return this.pass();
    if (step._stepKey !== 'getSearch' && step._stepKey !== 'getPrice') return this.pass();

    const data = response.data;
    if (!data || !Array.isArray(data.Trips)) return this.pass();

    const errors = [];
    const warnings = [];

    // RT can be represented as either:
    //   A) Two separate trip objects in Trips[]
    //   B) Two Journey objects within a single Trip
    const trips = data.Trips;

    if (trips.length === 0) {
      return this.fail('No trips in roundtrip response');
    }

    // Case A: 2 trip objects
    if (trips.length >= 2) {
      const outboundJourneys = trips[0].Journey || [];
      const returnJourneys   = trips[1].Journey || [];

      if (outboundJourneys.length === 0) errors.push('Outbound leg (Trips[0]) has no journeys');
      if (returnJourneys.length === 0)   errors.push('Return leg (Trips[1]) has no journeys');

      // Cross-leg airport check
      if (outboundJourneys.length > 0 && returnJourneys.length > 0) {
        const outLastSeg  = this._lastSegment(outboundJourneys[0]);
        const retFirstSeg = this._firstSegment(returnJourneys[0]);

        if (outLastSeg && retFirstSeg) {
          const outArrival = outLastSeg.ArrivalCode || outLastSeg.To;
          const retDeparture = retFirstSeg.DepartureCode || retFirstSeg.From;
          if (outArrival !== retDeparture) {
            warnings.push(
              `RT leg mismatch: outbound arrives ${outArrival}, ` +
              `return departs from ${retDeparture}`
            );
          }
          // Date check
          if (outLastSeg.ArrivalTime && retFirstSeg.DepartureTime) {
            if (new Date(retFirstSeg.DepartureTime) < new Date(outLastSeg.ArrivalTime)) {
              errors.push('Return departure is before outbound arrival');
            }
          }
        }
      }
    } else {
      warnings.push('RT response has only 1 Trip object — ensure both legs are present');
    }

    if (errors.length > 0) return this.fail(...errors);
    if (warnings.length > 0) return this.warn(...warnings);
    return this.pass();
  }
}

module.exports = new RoundtripValidator();
