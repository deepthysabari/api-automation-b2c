'use strict';

const BaseValidator = require('../../airlines/base/BaseValidator');

/**
 * AvailabilityValidator — Validates lightweight flight availability results.
 *
 * Checks:
 *   - At least one flight result exists
 *   - Airline code returned matches "6E" (IndiGo)
 *   - Segment count > 0 for returned journeys (using Segments or Connections)
 *   - Clear failure message if no availability returned
 */
class AvailabilityValidator extends BaseValidator {
  constructor() {
    super('availability');
  }

  validate(response, context, scenario, step) {
    // Only run on the GetExpSearch step
    if (step._stepKey !== 'getSearch') return this.pass();

    const data = response.data;
    if (!data) {
      return this.fail('Availability validation failed: No response data returned from search');
    }

    if (!Array.isArray(data.Trips) || data.Trips.length === 0) {
      return this.fail('Availability validation failed: No flight results returned in search results (Trips array is empty)');
    }

    const expectedAirlineStr = (scenario.dimensions?.airline || '').toUpperCase().trim();
    const airlineResolver = require('../../engine/airlineResolver');
    const searchMode = airlineResolver.resolveSearchMode(scenario);
    
    // Split by comma to support multiple airlines (e.g. "6E, AI, SG")
    const expectedAirlines = expectedAirlineStr ? expectedAirlineStr.split(',')
      .map(a => airlineResolver.baseCarrier(a))
      .filter(Boolean) : [];

    // The "all these airlines should be present" check is only meaningful for the
    // marketplace mode's "is every expected carrier there" assertion — and only for
    // carriers the picked route pool actually declares. A route pool entry (e.g. a
    // regional/low_frequency route serving only IC or S5) carries its own "airlines"
    // list on scenario.dataset (spread in from config/sectorPools/*.json in
    // scenarios/generator.js). Scope the check to that intersection so a route that
    // was never expected to carry AI/SG isn't asserted against a one-size-fits-all list.
    const routeAirlines = Array.isArray(scenario.dataset?.airlines)
      ? scenario.dataset.airlines.map(a => String(a).toUpperCase().trim())
      : null;
    const scopedExpectedAirlines = routeAirlines
      ? expectedAirlines.filter(a => routeAirlines.includes(a))
      : expectedAirlines;

    // Map to keep track of which expected (scoped) airlines are found
    const foundAirlinesMap = {};
    scopedExpectedAirlines.forEach(a => {
      foundAirlinesMap[a] = false;
    });

    const receivedAirlines = new Set();
    const errors = [];
    const warnings = [];
    let validFlightCount = 0;
    let totalJourneys = 0;

    data.Trips.forEach((trip, ti) => {
      const journeys = trip.Journey || [];
      totalJourneys += journeys.length;

      journeys.forEach((journey, ji) => {
        // Search response contains flight segments in Connections, later stages use Segments
        let segments = journey.Segments || journey.Connections || [];
        if (segments.length === 0 && (journey.FlightNo || journey.VAC)) {
          segments = [journey];
        }
        
        if (segments.length === 0) {
          warnings.push(`Trip[${ti}].Journey[${ji}] has 0 segments/connections`);
          return;
        }

        validFlightCount++;

        segments.forEach((seg, si) => {
          // If it's a Connection, the flight details are directly in seg. Otherwise in seg.Flight
          const flight = seg.Flight || seg;
          if (!flight) {
            errors.push(`Trip[${ti}].Journey[${ji}].Segment[${si}] is missing flight details`);
            return;
          }

          // Validate airline code matches expected airline if specified
          let carrier = (flight.VAC || flight.MAC || flight.OAC || '').toUpperCase().trim();
          const flightNo = (flight.FlightNo || '').toUpperCase().trim();

          if (carrier.includes('|')) {
            carrier = carrier.split('|')[0].trim();
          }

          if (carrier) {
            receivedAirlines.add(carrier);
          } else if (flightNo) {
            const match = flightNo.match(/^[A-Z0-9]{2,3}/);
            if (match) {
              receivedAirlines.add(match[0]);
            }
          }

          // Airline identity can live in either MAC or VAC depending on carrier, and neither
          // field is universally reliable on its own:
          //   - Akasa (QP) preferred search returns journeys with VAC "JCL"/"BNT"/"AIQ" (an
          //     independent aggregator — JustClick/Book & Travel/airIQ — reselling QP's
          //     inventory) but MAC "QP", the genuine carrier. VAC-only matching false-flags this.
          //   - Etihad (EY) returns some journeys where MAC is blank/different but VAC is
          //     correctly "EY". MAC-only matching false-flags THIS one instead.
          // So a match via EITHER field counts. baseCarrier() still resolves a carrier's own real
          // sub-brand channels (IndiGo's C6E/E6E/S6E, whose MAC IS the channel code) to the parent.
          const macIdentity = airlineResolver.baseCarrier((flight.MAC || '').toUpperCase().trim());
          const vacIdentity = airlineResolver.baseCarrier((flight.VAC || flight.OAC || '').toUpperCase().trim());

          if (expectedAirlines.length > 0) {
            if (searchMode === 'preferred') {
              const matchesAny = expectedAirlines.some(expected =>
                macIdentity.includes(expected) || vacIdentity.includes(expected) || flightNo.startsWith(expected));
              if (!matchesAny) {
                const receivedListStr = receivedAirlines.size > 0 ? Array.from(receivedAirlines).join(', ') : 'None';
                errors.push(`Trip[${ti}].Journey[${ji}].Segment[${si}] flight carrier "${carrier}" (Flight: "${flightNo}") does not match expected "${expectedAirlineStr}". Received airlines: [${receivedListStr}].`);
              }
            } else {
              scopedExpectedAirlines.forEach(expected => {
                if (macIdentity.includes(expected) || vacIdentity.includes(expected) || flightNo.startsWith(expected)) {
                  foundAirlinesMap[expected] = true;
                }
              });
            }
          }
        });
      });
    });

    if (totalJourneys === 0 || validFlightCount === 0) {
      return this.fail('Availability validation failed: No availability/flight results returned in search results');
    }

    if (scopedExpectedAirlines.length > 0 && searchMode === 'marketplace') {
      const missingAirlines = scopedExpectedAirlines.filter(a => !foundAirlinesMap[a]);
      if (missingAirlines.length > 0) {
        const limitedAirlines = [
          'S5', 'S51', 'IC', '9I', 'QP', 'IX', 'UK', 'EK', 'EY', 'WY', 'LH', 'SQ', 'BA', 'AA', 'QR',
          'MH', 'SK', 'LO', 'CX', 'LX', 'GF', 'UL', 'ET', 'TK', 'SV', 'TG', 'AF', 'A3', 'VS', 'AZ', 'VN', 'KL', 'KQ', 'RX',
          // Channel sub-codes (low daily volume, sold only on specific fare classes)
          'C6E', 'S6E', 'CSG', 'ESG', 'SSG', 'EQP', 'N6E',
          // Seasonal/low-frequency international carriers confirmed live per the QC pre-live
          // matrix but not guaranteed to have inventory on an arbitrary search date
          'G9', '3L', 'AK', 'XY', 'TZ', 'TZN', 'OD', 'FZ', 'OV', 'J9', 'BS', '8D', 'T5', 'DD', 'C6', 'VJ',
          // Domestic multicity is N independent one-way searches per leg (see
          // docs/changes/2026-07-31-domestic-mc-expresssearch-tui-independence.md) — any
          // domestic carrier is eligible, but a carrier's absence on one leg's specific
          // route/date is ordinary OW-style inventory variance, not a structural gap
          'SG'
        ];
        const strictMissing = missingAirlines.filter(a => !limitedAirlines.includes(a));
        const optionalMissing = missingAirlines.filter(a => limitedAirlines.includes(a));

        const receivedListStr = receivedAirlines.size > 0 ? Array.from(receivedAirlines).join(', ') : 'None';

        if (strictMissing.length > 0) {
          errors.push(`Expected airlines [${strictMissing.join(', ')}] were not present in the marketplace search results. Received airlines: [${receivedListStr}].`);
        }
        if (optionalMissing.length > 0) {
          warnings.push(`Optional/limited availability airlines [${optionalMissing.join(', ')}] were not present in the marketplace search results. Received airlines: [${receivedListStr}].`);
        }
      }
    }

    if (errors.length > 0) {
      return this.fail(...errors);
    }

    if (warnings.length > 0) {
      return this.warn(...warnings);
    }

    return this.pass();
  }
}

module.exports = new AvailabilityValidator();
