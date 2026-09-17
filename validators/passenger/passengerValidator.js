'use strict';

const BaseValidator = require('../../airlines/base/BaseValidator');

/**
 * PassengerValidator — Validates passenger count and PTC fare breakdown.
 *
 * Checks:
 *   - ADT/CHD/INF in response matches what was requested
 *   - PTC fare breakdown exists for each passenger type in the request
 */
class PassengerValidator extends BaseValidator {
  constructor() { super('passenger'); }

  validate(response, context, scenario, step) {
    if (step && step._stepKey === 'createItinerary') {
      return this.pass();
    }
    const data = response.data;
    if (!data) return this.pass();

    const errors = [];
    const warnings = [];
    const { passengerMix } = scenario.dimensions;

    // ── Top-level ADT/CHD/INF counts (present in GetSPricer)
    if (step._stepKey === 'getPrice') {
      if (data.ADT !== undefined && data.ADT !== passengerMix.ADT) {
        errors.push(`ADT count mismatch: requested ${passengerMix.ADT}, got ${data.ADT}`);
      }
      if (data.CHD !== undefined && data.CHD !== passengerMix.CHD) {
        errors.push(`CHD count mismatch: requested ${passengerMix.CHD}, got ${data.CHD}`);
      }
      if (data.INF !== undefined && data.INF !== passengerMix.INF) {
        errors.push(`INF count mismatch: requested ${passengerMix.INF}, got ${data.INF}`);
      }
    }

    // ── PTC fare breakdown per segment
    if (Array.isArray(data.Trips)) {
      data.Trips.forEach((trip, ti) => {
        (trip.Journey || []).forEach((journey, ji) => {
          if (!journey) return;
          (journey.Segments || []).forEach((seg, si) => {
            const ptcFares = seg?.Fares?.PTCFare;
            if (!Array.isArray(ptcFares)) return;

            const ptcCodes = ptcFares.map(p => p.PTC);

            if (passengerMix.ADT > 0 && !ptcCodes.includes('ADT')) {
              errors.push(`Segment[${si}] missing ADT PTC fare entry`);
            }
            if (passengerMix.CHD > 0 && !ptcCodes.includes('CHD')) {
              warnings.push(`Segment[${si}] missing CHD PTC fare (may be combined with ADT)`);
            }
            if (passengerMix.INF > 0 && !ptcCodes.includes('INF')) {
              warnings.push(`Segment[${si}] missing INF PTC fare`);
            }
          });
        });
      });
    }

    if (errors.length > 0) return this.fail(...errors);
    if (warnings.length > 0) return this.warn(...warnings);
    return this.pass();
  }
}

module.exports = new PassengerValidator();
