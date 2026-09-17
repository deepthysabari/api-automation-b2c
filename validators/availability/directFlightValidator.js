'use strict';

const BaseValidator = require('../../airlines/base/BaseValidator');

/**
 * DirectFlightValidator — Verifies that all flight options returned in GetExpSearch
 * are direct flights: Stops is empty/0 AND the journey has a single flight segment.
 *
 * NOTE: in the search response the flight segments are carried in `Connections`
 * (later stages use `Segments`) — see availabilityValidator. A direct flight has
 * exactly ONE real leg; a connection has two or more. `Connections.length > 0` is
 * therefore NOT a stop signal on its own — every flight, direct or not, may carry a
 * `Connections` entry (a technical halt, `Type: "H"`, still Stops:0/one FlightNo).
 * Segment count uses BaseValidator._segmentsOf(), which correctly reconstructs real
 * legs from Stops + Connections and excludes halts (see
 * docs/changes/2026-07-27-technical-halt-flightno-false-positive.md).
 */
class DirectFlightValidator extends BaseValidator {
  constructor() {
    super('directFlight');
  }

  validate(response, context, scenario, step) {
    // Only run on the GetExpSearch step
    if (step._stepKey !== 'getSearch') return this.pass();

    const data = response.data;
    if (!data) {
      return this.fail('Direct Flight validation failed: No response data returned from search');
    }

    if (!Array.isArray(data.Trips) || data.Trips.length === 0) {
      return this.pass(); // Let availability validator handle empty results
    }

    const errors = [];

    data.Trips.forEach((trip, ti) => {
      const journeys = trip.Journey || [];
      
      journeys.forEach((journey, ji) => {
        const stops = journey.Stops;
        const segments = this._segmentsOf(journey);
        const flightNo = (journey.FlightNo || '').trim();
        const carrier = (journey.VAC || journey.MAC || '').trim();

        // Non-direct if Stops says so, or the journey has more than one segment.
        const hasStops =
          (stops !== undefined && stops !== null && stops !== 0 && stops !== '0' && String(stops).trim() !== '') ||
          segments.length > 1;

        if (hasStops) {
          errors.push(
            `Trip[${ti}].Journey[${ji}] is not a direct flight. ` +
            `Flight: "${carrier} ${flightNo}", Stops: "${stops}", Segment Count: ${segments.length}`
          );
        }
      });
    });

    if (errors.length > 0) {
      return this.fail(...errors);
    }

    return this.pass();
  }
}

module.exports = new DirectFlightValidator();
