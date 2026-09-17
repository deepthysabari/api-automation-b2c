'use strict';

const BaseValidator = require('../../airlines/base/BaseValidator');

/**
 * NearbyAirportValidator — Validates and counts flights returned for the requested
 * nearby airport code (if any are returned in the response).
 */
class NearbyAirportValidator extends BaseValidator {
  constructor() {
    super('nearbyAirport');
  }

  validate(response, context, scenario, step) {
    // Only run on the GetExpSearch step
    if (step._stepKey !== 'getSearch') return this.pass();

    const data = response.data;
    if (!data || !Array.isArray(data.Trips)) return this.pass();

    const nearbyAirport = (scenario.dimensions?.nearbyAirport || '').toUpperCase().trim();
    if (!nearbyAirport) return this.pass();

    let mainRouteCount = 0;
    let nearbyRouteCount = 0;
    const foundAirports = new Set();

    data.Trips.forEach((trip) => {
      const journeys = trip.Journey || [];
      journeys.forEach((journey) => {
        let segments = journey.Segments || journey.Connections || [];
        if (segments.length === 0 && (journey.FlightNo || journey.VAC)) {
          segments = [journey];
        }

        segments.forEach((seg) => {
          const flight = seg.Flight || seg;
          if (flight) {
            const dep = (flight.DepartureCode || flight.From || '').toUpperCase().trim();
            const arr = (flight.ArrivalCode || flight.To || '').toUpperCase().trim();
            
            if (dep) foundAirports.add(dep);
            if (arr) foundAirports.add(arr);

            if (dep === nearbyAirport || arr === nearbyAirport) {
              nearbyRouteCount++;
            } else {
              mainRouteCount++;
            }
          }
        });
      });
    });

    const infoMsg = `Main route segments: ${mainRouteCount}, Nearby airport (${nearbyAirport}) segments: ${nearbyRouteCount}. Found airports in response: [${Array.from(foundAirports).join(', ')}]`;

    if (nearbyRouteCount > 0) {
      return this.warn(`Nearby airport flights found! ${infoMsg}`);
    } else {
      return this.warn(`No nearby airport flights found (optional check). ${infoMsg}`);
    }
  }
}

module.exports = new NearbyAirportValidator();
