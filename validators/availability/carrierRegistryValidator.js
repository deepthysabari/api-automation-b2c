'use strict';

const BaseValidator = require('../../airlines/base/BaseValidator');
const airlineResolver = require('../../engine/airlineResolver');

/**
 * CarrierRegistryValidator — Proactively flags carrier codes surfaced in a
 * GetExpSearch response that are NOT registered in configs/airlines.json.
 *
 * Why: NDC/GDS aggregators (e.g. Sabre's "1SN") surface "N airlines as per
 * settings" on the live API side, and new carriers can appear under an
 * aggregator Provider value at any time, unannounced — there is no code-side
 * way to know the set in advance. This validator walks every journey the same
 * way availabilityValidator does, collects each segment's carrier identity
 * (VAC/MAC/OAC, same precedence/pipe-delimited handling), and warns once per
 * distinct unregistered code per response so it can be triaged and added to
 * configs/airlines.json before it trips a later step's fail-fast carrier
 * resolution (see airlines/registry.js).
 *
 * This is intentionally NOT scoped to Provider "1SN" — any provider (1G, SB,
 * 1SN, ...) could surface a carrier we don't yet know about — and it is
 * intentionally a WARNING, not a failure: an unregistered carrier appearing
 * incidentally in a marketplace search isn't fatal to the current scenario.
 *
 * Since capability now lives on the PROVIDER (configs/airlines.json's GDS/NDC
 * buckets), the warning distinguishes two very different gaps:
 *   - known provider, unlisted carrier → documentation only; the provider's
 *     capability block already governs that carrier's behaviour.
 *   - unrecognized provider → a whole new channel, with no capability behind
 *     it; that provider entry is what actually needs adding.
 */
class CarrierRegistryValidator extends BaseValidator {
  constructor() {
    super('carrierRegistry');
  }

  validate(response, context, scenario, step) {
    // Only run on the GetExpSearch step
    if (step._stepKey !== 'getSearch') return this.pass();

    const data = response.data;
    if (!data || !Array.isArray(data.Trips)) return this.pass();

    // code -> Set of Provider values it was seen under
    const unregistered = new Map();

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
          if (!carrier) return;

          if (!airlineResolver.getAirline(carrier)) {
            const provider = (journey.Provider || flight.Provider || trip.Provider || '').toUpperCase().trim();
            if (!unregistered.has(carrier)) {
              unregistered.set(carrier, new Set());
            }
            if (provider) unregistered.get(carrier).add(provider);
          }
        });
      });
    });

    if (unregistered.size === 0) return this.pass();

    const warnings = Array.from(unregistered.entries()).map(([code, providers]) => {
      const providerList = Array.from(providers);
      const providerStr = providerList.length > 0
        ? providerList.map(p => `"${p}"`).join(', ')
        : 'unknown';

      // Split the providers this carrier was seen under into ones we already model (1G/SB/AM/1SN,
      // whose `capability` block already covers any carrier they sell) and ones we don't.
      const known = providerList.filter(p => airlineResolver.isKnownProvider(p));
      const unknownProviders = providerList.filter(p => !airlineResolver.isKnownProvider(p));

      if (known.length > 0 && unknownProviders.length === 0) {
        // Documentation-only gap: capability is already correct via the provider, the carrier just
        // isn't listed yet. Never a blocker.
        const provider = known[0];
        const category = airlineResolver.getProviderCategory(provider);
        return `Carrier "${code}" seen under known ${category} provider "${provider}" but not yet ` +
          `listed in configs/airlines.json's ${category}.${provider}.airlines — add it there for ` +
          `documentation (capability is already covered by the provider).`;
      }

      // A provider we don't recognise at all — that's the entry that actually needs adding, since
      // there is no capability block behind it.
      const provider = unknownProviders[0] || providerList[0] || 'unknown';
      return `Carrier "${code}" (seen on unrecognized Provider(s) ${providerStr}) is not ` +
        `registered — if this is a new GDS/NDC channel, add a "${provider}" entry under GDS or NDC ` +
        `in configs/airlines.json; otherwise register the carrier directly under LCC.`;
    });

    return this.warn(...warnings);
  }
}

module.exports = new CarrierRegistryValidator();
