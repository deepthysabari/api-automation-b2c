'use strict';

const BaseValidator = require('../../airlines/base/BaseValidator');
const airlineResolver = require('../../engine/airlineResolver');

/**
 * ProviderAvailabilityValidator — the ground-truth check that a specific GDS/NDC
 * provider (1G, SB, AM, 1SN, ...) is genuinely serving live inventory.
 *
 * Why this exists: a given carrier can move between providers day to day (e.g. LX has
 * been observed under 1G, SB and AM), so asserting "provider X works" by searching for
 * one hardcoded carrier code is unreliable — that carrier may simply have moved to a
 * different provider today, producing a false failure, or worse, a false pass if it
 * happens to also be sold as an LCC-native carrier.
 *
 * The reliable signal, per the manual verification process this encodes: run a
 * marketplace search (all airlines) on a common sector, then check whether AT LEAST ONE
 * carrier in the response actually resolves (via airlineResolver.getAirline) to the
 * expected provider's `_providers` list. That is direct proof the provider itself
 * returned live inventory — regardless of which carrier(s) it happened to sell today.
 *
 * This is a hard assertion for most providers: if the expected provider is declared on the
 * scenario but no returned carrier resolves to it, that's the real failure this validator
 * exists to catch. The one exception is `OPTIONAL_PROVIDERS` below — providers whose ONLY
 * confirmed member carrier(s) are themselves low-frequency/single-route (e.g. VTL's only
 * confirmed carrier is TK), so a miss is ordinary live-inventory variance, not a defect,
 * the same reasoning availabilityValidator.js's `limitedAirlines` list already applies to
 * carriers like S5/IC/9I. A miss on an optional provider downgrades to a warning.
 *
 * MULTIPLE providers may be declared on one scenario (`dimensions.expectedProviders`, one
 * entry per stacked `validate provider "..." availability` step). Each is evaluated
 * INDEPENDENTLY against the same single search response and every failure is accumulated,
 * so one run reports all missing providers at once instead of stopping at the first.
 *
 * Carrier extraction mirrors availabilityValidator.js / carrierRegistryValidator.js
 * exactly (VAC/MAC/OAC precedence, pipe-delimited handling) so all three validators stay
 * consistent about "what carrier did this segment belong to".
 */
// Providers known to be inherently flaky against live inventory — a miss here warns
// instead of failing. Keep this list short and justified; see the class doc above.
const OPTIONAL_PROVIDERS = ['VTL'];

class ProviderAvailabilityValidator extends BaseValidator {
  constructor() {
    super('providerAvailability');
  }

  validate(response, context, scenario, step) {
    // Only run on the GetExpSearch step
    if (step._stepKey !== 'getSearch') return this.pass();

    const expectedProviders = this._expectedProviders(scenario);
    // Nothing to check against — the scenario didn't opt in via
    // `validate provider "..." availability`. Never fabricate an expectation.
    if (expectedProviders.length === 0) return this.pass();

    const data = response.data;
    if (!data || !Array.isArray(data.Trips) || data.Trips.length === 0) {
      return this.fail(
        `Provider availability validation failed: no flight results returned in search results ` +
        `(Trips array is empty) — cannot verify provider(s) ` +
        `${expectedProviders.map(p => `"${p}"`).join(', ')} are serving live inventory.`
      );
    }

    const seenCarriers = new Set();

    data.Trips.forEach(trip => {
      const journeys = trip.Journey || [];
      journeys.forEach(journey => {
        let segments = journey.Segments || journey.Connections || [];
        if (segments.length === 0 && (journey.FlightNo || journey.VAC)) {
          segments = [journey];
        }

        segments.forEach(seg => {
          const flight = seg.Flight || seg;
          if (!flight) return;

          let carrier = (flight.VAC || flight.MAC || flight.OAC || '').toUpperCase().trim();
          if (carrier.includes('|')) {
            carrier = carrier.split('|')[0].trim();
          }
          if (carrier) seenCarriers.add(carrier);
        });
      });
    });

    const carriers = Array.from(seenCarriers);
    const receivedListStr = carriers.length > 0 ? carriers.join(', ') : 'None';

    // Evaluate EVERY declared provider against the same response. No short-circuit: a
    // scenario stacking SB + AM + 1G + VTL must report each missing provider in one run.
    const errors = [];
    const warnings = [];
    const confirmed = [];

    expectedProviders.forEach(expectedProvider => {
      const matched = carriers.filter(code => {
        const airline = airlineResolver.getAirline(code);
        return Array.isArray(airline?._providers) && airline._providers.includes(expectedProvider);
      });

      if (matched.length > 0) {
        confirmed.push(
          `Provider "${expectedProvider}" confirmed working — carrier(s) [${matched.join(', ')}] in the ` +
          `response resolve to it.`
        );
      } else {
        const message =
          `Provider availability validation ${OPTIONAL_PROVIDERS.includes(expectedProvider) ? 'warning' : 'failed'}: ` +
          `no carrier in the marketplace search results resolves to expected provider "${expectedProvider}". ` +
          `Received airlines: [${receivedListStr}]. This means provider "${expectedProvider}" did not serve ` +
          `any live inventory in this response.`;
        if (OPTIONAL_PROVIDERS.includes(expectedProvider)) {
          warnings.push(message);
        } else {
          errors.push(message);
        }
      }
    });

    if (errors.length > 0) return this.fail(...errors);
    if (warnings.length > 0) return this.warn(...warnings);
    return this.pass(confirmed.join(' '));
  }

  /**
   * Declared providers for this scenario, normalised to an upper-cased, de-duplicated
   * array. `dimensions.expectedProviders` (plural array, written by bddInterpreter's
   * `validate provider "..." availability` handler) is the canonical field; a legacy
   * scalar `dimensions.expectedProvider` is still accepted so hand-built scenario objects
   * keep working.
   * @param {Object} scenario
   * @returns {string[]}
   */
  _expectedProviders(scenario) {
    const raw = scenario?.dimensions?.expectedProviders ?? scenario?.dimensions?.expectedProvider;
    const list = Array.isArray(raw) ? raw : [raw];
    return Array.from(new Set(
      list.map(p => String(p || '').toUpperCase().trim()).filter(Boolean)
    ));
  }
}

module.exports = new ProviderAvailabilityValidator();
