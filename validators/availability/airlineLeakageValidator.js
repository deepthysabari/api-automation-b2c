'use strict';

const BaseValidator = require('../../airlines/base/BaseValidator');
const airlineResolver = require('../../engine/airlineResolver');

/**
 * AirlineLeakageValidator — Asserts that no unexpected airline flights leak 
 * into results during a Preferred Airline Search mode.
 */
class AirlineLeakageValidator extends BaseValidator {
  constructor() {
    super('airlineLeakage');
  }

  validate(response, context, scenario, step) {
    // Only run on the GetExpSearch step
    if (step._stepKey !== 'getSearch') return this.pass();

    const data = response.data;
    if (!data || !Array.isArray(data.Trips)) return this.pass();

    const searchMode = airlineResolver.resolveSearchMode(scenario);
    if (searchMode !== 'preferred') return this.pass();

    const expectedAirline = (scenario.dimensions?.airline || '').toUpperCase().trim();
    if (!expectedAirline) return this.pass();

    const errors = [];

    data.Trips.forEach((trip, ti) => {
      const journeys = trip.Journey || [];
      journeys.forEach((journey, ji) => {
        let segments = journey.Segments || journey.Connections || [];
        if (segments.length === 0 && (journey.FlightNo || journey.VAC)) {
          segments = [journey];
        }
        
        segments.forEach((seg, si) => {
          const flight = seg.Flight || seg;
          if (!flight) return;

          const carrier = (flight.VAC || flight.MAC || flight.OAC || '').toUpperCase().trim();
          const flightNo = (flight.FlightNo || '').toUpperCase().trim();

          // Airline identity can live in either MAC or VAC depending on carrier — neither field
          // is universally reliable alone. VAC can be an independent aggregator (JustClick, Book
          // & Travel, airIQ, ...) reselling ANY carrier's inventory while MAC "QP" (Akasa) stays
          // correct; conversely EY (Etihad) has journeys where MAC is blank/different but VAC is
          // correctly "EY". A match via EITHER field counts. baseCarrier() still resolves a
          // carrier's own real sub-brand channels (IndiGo's C6E/E6E/S6E) to the parent carrier.
          const targetExpected = airlineResolver.baseCarrier(expectedAirline);
          const macIdentity = airlineResolver.baseCarrier((flight.MAC || '').toUpperCase().trim());
          const vacIdentity = airlineResolver.baseCarrier((flight.VAC || flight.OAC || '').toUpperCase().trim());
          const isExpected = macIdentity.includes(targetExpected) || vacIdentity.includes(targetExpected) || flightNo.startsWith(targetExpected);
          if (!isExpected) {
            errors.push(`Trip[${ti}].Journey[${ji}].Segment[${si}] leaked unexpected carrier "${carrier}" (Flight: "${flightNo}"). Expected: "${expectedAirline}"`);
          }
        });
      });
    });

    if (errors.length > 0) {
      return this.fail(...errors);
    }

    return this.pass();
  }
}

module.exports = new AirlineLeakageValidator();
