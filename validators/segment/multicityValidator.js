'use strict';

const BaseValidator = require('../../airlines/base/BaseValidator');

/**
 * MulticityValidator — Validates multicity-specific response structure.
 *
 * Only activates when scenario.dimensions.tripType === 'MC'.
 * Checks:
 *   - Number of trips/sectors in response >= number of city pairs requested
 *   - Each sector's departure airport matches the previous sector's arrival
 */
class MulticityValidator extends BaseValidator {
  constructor() { super('multicity'); }

  validate(response, context, scenario, step) {
    if (scenario.dimensions.tripType !== 'MC') return this.pass();
    if (step._stepKey !== 'getSearch' && step._stepKey !== 'getPrice') return this.pass();

    const data = response.data;
    if (!data || !Array.isArray(data.Trips)) return this.pass();

    const errors = [];
    const warnings = [];
    const sectors = scenario.dataset?.sectors || [];
    const isLiveDM = scenario.dimensions.tripType === 'MC' && scenario.dimensions.sectorType === 'DOM';

    if (isLiveDM) {
      if (data.Trips.length < 1) {
        errors.push(`Expected >= 1 Trip object, got 0`);
      }
      
      const legIndex = step._legIndex !== undefined ? step._legIndex : 0;
      const trip = data.Trips[0];
      const sector = sectors[legIndex];
      if (trip && sector) {
        const firstSeg = this._firstSegment((trip.Journey || [])[0]);
        const firstSegDeparture = firstSeg?.DepartureCode || firstSeg?.From;
        if (firstSegDeparture && sector.origin && firstSegDeparture !== sector.origin) {
          errors.push(
            `MC Leg[${legIndex}] departure ${firstSegDeparture} ≠ requested origin ${sector.origin}`
          );
        }
      }
    } else {
      // Check we have enough trip objects for the city pairs
      if (data.Trips.length < sectors.length) {
        errors.push(
          `Expected >= ${sectors.length} Trip objects for MC, got ${data.Trips.length}`
        );
      }

      // Validate sector connectivity: arrival of sector N == departure of sector N+1
      for (let i = 0; i + 1 < data.Trips.length; i++) {
        const currentJourneys = data.Trips[i].Journey || [];
        const nextJourneys    = data.Trips[i + 1].Journey || [];

        if (currentJourneys.length === 0 || nextJourneys.length === 0) continue;

        const currentLastSeg = this._lastSegment(currentJourneys[0]);
        const nextFirstSeg   = this._firstSegment(nextJourneys[0]);

        if (currentLastSeg && nextFirstSeg) {
          const currentArrival = currentLastSeg.ArrivalCode || currentLastSeg.To;
          const nextDeparture = nextFirstSeg.DepartureCode || nextFirstSeg.From;
          if (currentArrival !== nextDeparture) {
            warnings.push(
              `MC Sector[${i}] arrives ${currentArrival} ` +
              `but Sector[${i + 1}] departs from ${nextDeparture}`
            );
          }
        }
      }

      // Cross-check with requested sectors if available
      sectors.forEach((sector, i) => {
        const trip = data.Trips[i];
        if (!trip) return;

        const firstSeg = this._firstSegment((trip.Journey || [])[0]);
        const firstSegDeparture = firstSeg?.DepartureCode || firstSeg?.From;
        if (firstSegDeparture && sector.origin && firstSegDeparture !== sector.origin) {
          errors.push(
            `MC Sector[${i}] departure ${firstSegDeparture} ≠ requested origin ${sector.origin}`
          );
        }
      });
    }

    if (errors.length > 0) return this.fail(...errors);
    if (warnings.length > 0) return this.warn(...warnings);
    return this.pass();
  }
}

module.exports = new MulticityValidator();
