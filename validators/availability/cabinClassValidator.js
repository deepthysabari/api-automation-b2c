'use strict';

const BaseValidator = require('../../airlines/base/BaseValidator');

/**
 * CabinClassValidator — Verifies that all flight options returned in GetExpSearch
 * match the requested cabin class (e.g. E for Economy, B for Business).
 */
class CabinClassValidator extends BaseValidator {
  constructor() {
    super('cabinClass');
  }

  validate(response, context, scenario, step) {
    // Only run on the GetExpSearch step
    if (step._stepKey !== 'getSearch') return this.pass();

    const data = response.data;
    if (!data) {
      return this.fail('Cabin Class validation failed: No response data returned from search');
    }

    if (!Array.isArray(data.Trips) || data.Trips.length === 0) {
      return this.pass(); // Let availability validator handle empty results
    }

    const expectedCabin = (scenario.dimensions?.expectedCabin || scenario.dimensions?.cabinClass || '').toUpperCase().trim();
    if (!expectedCabin) return this.pass();

    const isInt = (scenario.dimensions?.sectorType || '').toUpperCase() === 'INT';
    const isMarketplace = (scenario.dimensions?.searchMode || '').toUpperCase() === 'MARKETPLACE';
    const airlineCode = (scenario.dimensions?.airline || '').toUpperCase().trim();
    // LCC-ness is a carrier capability, not validator logic — read it from the registry
    // (configs/airlines.json) rather than a hardcoded list, so a newly-onboarded LCC works
    // automatically. IsLcc is defined per carrier there, including the 6E channels (C6E/S6E/E6E).
    const isLcc = require('../../engine/airlineResolver').getAirline(airlineCode)?.IsLcc === true;
    const errors = [];
    const warnings = [];

    data.Trips.forEach((trip, ti) => {
      const journeys = trip.Journey || [];
      
      journeys.forEach((journey, ji) => {
        // Retrieve cabin from journey object or its segments/connections
        const journeyCabin = (journey.Cabin || '').toUpperCase().trim();
        
        let segments = journey.Segments || journey.Connections || [];
        if (segments.length === 0 && (journey.FlightNo || journey.VAC)) {
          segments = [journey];
        }

        let segmentsMatchExpected = true;
        const segmentCabins = [];

        segments.forEach((seg) => {
          const flight = seg.Flight || seg;
          if (flight) {
            const segCabin = (flight.Cabin || '').toUpperCase().trim();
            if (segCabin) {
              segmentCabins.push(segCabin);
              if (segCabin !== expectedCabin) {
                segmentsMatchExpected = false;
              }
            }
          }
        });

        // Fail if the journey cabin is mismatched OR segments are mismatched
        const hasMismatch = (journeyCabin && journeyCabin !== expectedCabin) || (!journeyCabin && !segmentsMatchExpected);

        if (hasMismatch) {
          const flightNo = (journey.FlightNo || (segments[0] && segments[0].FlightNo) || '').trim();
          const carrier = (journey.VAC || journey.MAC || '').trim();
          const msg = `Trip[${ti}].Journey[${ji}] (Flight: "${carrier} ${flightNo}") cabin class mismatch. ` +
            `Expected: "${expectedCabin}", Journey Cabin: "${journeyCabin}", Segment Cabins: [${segmentCabins.join(', ')}]`;
          
          if (isInt || isMarketplace || isLcc) {
            warnings.push(msg);
          } else {
            errors.push(msg);
          }
        }
      });
    });

    if (errors.length > 0) {
      return { passed: false, errors, warnings };
    }

    if (warnings.length > 0) {
      return this.warn(...warnings);
    }

    return this.pass();
  }
}

module.exports = new CabinClassValidator();
