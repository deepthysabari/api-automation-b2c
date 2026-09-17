'use strict';

/**
 * ValidatorRegistry — Central registry mapping validator names to instances.
 *
 * The pipeline resolves validators by name from this registry.
 * Adding a new validator = add the import + add entry to REGISTRY.
 *
 * No airline-specific validators yet (ported from api-automation-node, which
 * namespaces them per IATA code under airlines/<CODE>/validators.js) — add the
 * same way once a B2C carrier needs its own checks.
 */

// ── Global validators (apply across all airlines)
const businessValidator  = require('./business/businessValidator');
const pricingValidator   = require('./pricing/pricingValidator');
const segmentValidator   = require('./segment/segmentValidator');
const passengerValidator = require('./passenger/passengerValidator');
const roundtripValidator = require('./segment/roundtripValidator');
const rsPackageValidator = require('./segment/rsPackageValidator');
const multicityValidator = require('./segment/multicityValidator');
const availabilityValidator = require('./availability/availabilityValidator');
const airlineLeakageValidator = require('./availability/airlineLeakageValidator');
const carrierRegistryValidator = require('./availability/carrierRegistryValidator');
const providerAvailabilityValidator = require('./availability/providerAvailabilityValidator');
const directFlightValidator = require('./availability/directFlightValidator');
const nearbyAirportValidator = require('./availability/nearbyAirportValidator');
const cabinClassValidator = require('./availability/cabinClassValidator');
const seniorCitizenValidator = require('./availability/seniorCitizenValidator');
const flightMatchValidator = require('./pricing/flightMatchValidator');
const rulesValidator = require('./pricing/rulesValidator');
const ssrValidator = require('./pricing/ssrValidator');
const ssrDetailsValidator = require('./pricing/ssrDetailsValidator');
const fareRuleValidator = require('./pricing/fareRuleValidator');
const itineraryValidator = require('./itinerary/itineraryValidator');

const REGISTRY = {
  // Global validators
  business:  businessValidator,
  pricing:   pricingValidator,
  segment:   segmentValidator,
  passenger: passengerValidator,
  availability: availabilityValidator,
  airlineLeakage: airlineLeakageValidator,
  carrierRegistry: carrierRegistryValidator,
  providerAvailability: providerAvailabilityValidator,
  directFlight: directFlightValidator,
  nearbyAirport: nearbyAirportValidator,
  cabinClass: cabinClassValidator,
  seniorCitizen: seniorCitizenValidator,
  roundtrip: roundtripValidator,
  rsPackage: rsPackageValidator,
  multicity: multicityValidator,
  flightMatch: flightMatchValidator,
  rules: rulesValidator,
  ssr: ssrValidator,
  ssrDetails: ssrDetailsValidator,
  fareRule: fareRuleValidator,
  itinerary: itineraryValidator

  // Airline-specific validators (namespaced by IATA code) go here as they're
  // added, e.g. ...indigo6EValidators — see airlines/<CODE>/validators.js.
};

class ValidatorRegistry {
  /**
   * Resolve a validator instance by name.
   * @param {string} name
   * @returns {BaseValidator}
   */
  resolve(name) {
    const validator = REGISTRY[name];
    if (!validator) {
      throw new Error(`[ValidatorRegistry] Unknown validator: "${name}". ` +
        `Available: ${Object.keys(REGISTRY).join(', ')}`);
    }
    return validator;
  }

  /**
   * Resolve multiple validators by name array.
   * @param {string[]} names
   * @returns {BaseValidator[]}
   */
  resolveAll(names) {
    return (names || []).map(name => this.resolve(name));
  }

  /**
   * List all registered validator names.
   * @returns {string[]}
   */
  list() {
    return Object.keys(REGISTRY);
  }
}

module.exports = new ValidatorRegistry();
