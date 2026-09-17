'use strict';

const fs = require('fs');
const path = require('path');

/**
 * AirlineResolver — the ONE place that understands the shape of configs/airlines.json.
 *
 * That registry has three top-level buckets:
 *   - LCC:  direct/native-integration carriers, keyed by code, each carrying its own
 *           capability fields inline (and, for a single carrier's alternate channel such as
 *           C6E/E6E/S6E or S51, a `parent`). "LCC" is a historical bucket name — full-service
 *           carriers live here too; the `IsLcc` flag inside is what distinguishes them.
 *   - GDS / NDC: third-party providers (1G, SB, AM, 1SN), each with ONE `capability` block plus
 *           an `airlines[]` list of the carrier codes it was observed selling.
 *
 * Capability belongs to the PROVIDER, not to each carrier: the same live carrier ("LX") was
 * observed under 1G, SB and AM in a single response, and the set of carriers a provider surfaces
 * shifts run to run — so a hand-maintained capability entry per incidentally-seen carrier is the
 * wrong model. A provider-derived carrier therefore gets a capability object SYNTHESISED from the
 * provider(s) that list it (see getAirline), never stored per carrier.
 *
 * No other module should parse configs/airlines.json directly.
 */
class AirlineResolver {
  constructor() {
    this.registryPath = path.join(__dirname, '../configs/airlines.json');
    this.airlines = {};    // flat LCC map — unchanged per-airline shape
    this.providers = {};   // providerCode -> { code, category, Name, capability, airlines[] }
    this._loadRegistry();
  }

  _loadRegistry() {
    let data;
    try {
      if (fs.existsSync(this.registryPath)) {
        data = JSON.parse(fs.readFileSync(this.registryPath, 'utf8'));
      } else {
        // configs/airlines.json is required — there is no mock/empty fallback.
        console.error(`[AirlineResolver] Required registry not found at ${this.registryPath}`);
        process.exit(1);
      }
    } catch (err) {
      console.error(`[AirlineResolver] Failed to load registry: ${err.message}`);
      process.exit(1);
    }

    this.airlines = data.LCC || {};
    this.providers = {};
    ['GDS', 'NDC'].forEach(category => {
      const bucket = data[category] || {};
      Object.entries(bucket).forEach(([providerCode, provider]) => {
        this.providers[providerCode] = {
          code: providerCode,
          category,
          Name: provider.Name || providerCode,
          capability: provider.capability || {},
          airlines: (provider.airlines || []).map(a => String(a).toUpperCase().trim())
        };
      });
    });
  }

  /**
   * Get metadata for a specific airline by IATA code.
   *
   * Resolution order:
   *   1. The LCC bucket — returned as-is (exact same object shape as the pre-bucket registry,
   *      `parent` included), so nothing about a directly-integrated carrier changes.
   *   2. Every GDS/NDC provider's `airlines[]` list. A code may legitimately match MORE than one
   *      provider, so all matches are merged CONSERVATIVELY: a boolean permission flag is true only
   *      if true for every matching provider (we can't know which provider will serve a given live
   *      search, so we must not promise a capability one of them lacks), while `sectorTypes` and
   *      `cabins` are unioned. `IsLcc` is always false for a provider-derived carrier, and no
   *      `parent` is added — "channel of one airline" doesn't apply to a third-party consolidator.
   *   3. Unknown → null (the fail-fast trigger for callers).
   *
   * @param {string} code
   * @returns {Object|null}
   */
  getAirline(code) {
    if (!code) return null;
    const cleanCode = code.toUpperCase().trim();

    const providerMatches = Object.values(this.providers)
      .filter(p => p.airlines.includes(cleanCode));

    // A top-level LCC entry is authoritative for its own capability fields, but it can
    // STILL be sold through one or more GDS/NDC providers (e.g. AI is both directly
    // integrated AND observed under SB/AMN) — without this, `validate provider "X"
    // availability` could never pass for any provider whose only listed carrier happens
    // to also be top-level registered, even when that's exactly the live behaviour.
    if (this.airlines[cleanCode]) {
      if (providerMatches.length === 0) return this.airlines[cleanCode];
      return {
        ...this.airlines[cleanCode],
        _providers: providerMatches.map(p => p.code)
      };
    }

    const matches = providerMatches;
    if (matches.length === 0) return null;

    const BOOLEAN_FLAGS = ['supportsMC', 'supportsSSR', 'supportsPaidSSR', 'supportsInfant'];
    const LIST_FIELDS = ['sectorTypes', 'cabins'];

    const merged = {};
    BOOLEAN_FLAGS.forEach(flag => {
      merged[flag] = matches.every(p => p.capability[flag] === true);
    });
    LIST_FIELDS.forEach(field => {
      const union = new Set();
      matches.forEach(p => (p.capability[field] || []).forEach(v => union.add(v)));
      merged[field] = Array.from(union);
    });

    return {
      Code: cleanCode,
      Name: cleanCode,
      ...merged,
      IsLcc: false,
      _providers: matches.map(p => p.code)
    };
  }

  /**
   * True if `providerCode` is a known GDS or NDC provider key (1G, SB, AM, 1SN, ...).
   * Used to tell "carrier we haven't documented yet, on a channel we DO understand" apart from
   * "a whole new channel appeared".
   * @param {string} providerCode
   * @returns {boolean}
   */
  isKnownProvider(providerCode) {
    if (!providerCode) return false;
    return !!this.providers[providerCode.toUpperCase().trim()];
  }

  /**
   * The category ('GDS' | 'NDC') a provider belongs to, or null if unknown.
   * @param {string} providerCode
   * @returns {string|null}
   */
  getProviderCategory(providerCode) {
    if (!providerCode) return null;
    return this.providers[providerCode.toUpperCase().trim()]?.category || null;
  }

  /**
   * Every airline code the platform knows about: the LCC bucket plus every provider's
   * `airlines[]` list, flat and deduped. Replaces the old `Object.keys(registry)`.
   * @returns {string[]}
   */
  getAllKnownCodes() {
    const codes = new Set(Object.keys(this.airlines));
    Object.values(this.providers).forEach(p => p.airlines.forEach(a => codes.add(a)));
    return Array.from(codes);
  }

  /**
   * All provider entries, keyed by provider code — for callers (e.g. the UI catalog) that need to
   * report which provider(s) sell a carrier.
   * @returns {Object}
   */
  getProviders() {
    return this.providers;
  }

  /**
   * Resolve a channel/sub-brand code to its parent carrier — e.g. the IndiGo channels
   * C6E / E6E / S6E all map to 6E. The mapping lives in configs/airlines.json as each channel's
   * `parent` field, so this stays the single source: onboarding a new channel needs no code change.
   * Returns the (normalised) code itself when it has no parent.
   * @param {string} code
   * @returns {string}
   */
  baseCarrier(code) {
    const cleanCode = (code || '').toUpperCase().trim();
    return this.getAirline(cleanCode)?.parent || cleanCode;
  }

  /**
   * Resolve search mode ('preferred' or 'marketplace') for a scenario.
   * @param {Object} scenario
   * @returns {string}
   */
  resolveSearchMode(scenario) {
    if (!scenario || !scenario.dimensions) return 'marketplace';

    const dims = scenario.dimensions;
    if (dims.searchMode) return dims.searchMode.toLowerCase();

    // If airline is explicitly specified in the scenario dimensions
    if (dims.airline && dims.airline !== '') {
      return 'preferred';
    }

    // Default to marketplace search (searches all airlines)
    return 'marketplace';
  }

  /**
   * Resolve preferred airlines array for ExpressSearch payloads.
   * Maps properties like Code, Name, SectorType, PaxLimit, IsLcc, isSelected.
   * @param {Object} scenario
   * @returns {Array<Object>}
   */
  getPreferedAirlines(scenario) {
    const searchMode = this.resolveSearchMode(scenario);
    if (searchMode === 'marketplace') return [];

    const airlineCode = scenario.dimensions?.airline || '';
    if (!airlineCode) return [];

    const airline = this.getAirline(airlineCode);
    if (!airline) return [];

    const isInt = (scenario.dimensions?.sectorType || 'DOM') === 'INT';
    const sectorTypeChar = isInt ? 'I' : 'D';

    // Code must be the real base-carrier code, not a channel/sub-brand code — verified live,
    // a channel code like "E6E" is not understood by the search API (Trips comes back empty);
    // the resolved base carrier ("6E") returns real results.
    return [
      {
        Code: this.baseCarrier(airline.Code),
        Name: airline.Name,
        SectorType: sectorTypeChar,
        PaxLimit: "9",
        IsLcc: airline.IsLcc,
        isSelected: true
      }
    ];
  }

  /**
   * Ensure selected airline supports the sector/trip type.
   * @param {string} code
   * @param {string} sectorType - DOM or INT
   * @returns {boolean}
   */
  isAirlineSupportedOnSector(code, sectorType) {
    const airline = this.getAirline(code);
    if (!airline) return false;
    return airline.sectorTypes.includes(sectorType.toUpperCase());
  }
}

module.exports = new AirlineResolver();
