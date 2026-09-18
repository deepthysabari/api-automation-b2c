'use strict';

const fs = require('fs');
const path = require('path');

// Global capability registry — the source of truth for which airlines the platform knows about.
// configs/airlines.json is nested (LCC / GDS / NDC buckets), so it is read ONLY through
// airlineResolver, which owns that shape: a code is "known" if it is in the LCC bucket or in any
// GDS/NDC provider's airlines[] list, and getAirline() synthesises the profile either way.
const airlineResolver = require('../engine/airlineResolver');

// Pseudo-code for a marketplace search, which is not tied to any one carrier.
const MARKETPLACE_CODE = 'B2B';

/**
 * AirlineRegistry — Auto-discovers and registers airline adapters.
 *
 * Convention: Each airline folder under airlines/<IATA>/ must contain:
 *   - adapter.js  (extends BaseAirlineAdapter)
 *
 * To add a new airline (e.g., SG - SpiceJet):
 *   1. mkdir airlines/SG
 *   2. Create airlines/SG/adapter.js
 *   3. That's it — registry auto-discovers it on next run
 *
 * Resolution order (see resolve()): explicit alias → own adapter → generic B2B adapter
 * (for a registered carrier with no plugin of its own) → throw. A carrier never silently
 * inherits another carrier's adapter.
 */

// A channel/sub-brand code (e.g. IndiGo's C6E/E6E/S6E) resolves to its parent carrier's adapter —
// it is that carrier's inventory sold through a different channel. The channel→parent mapping is
// declared once, as each channel's `parent` field in configs/airlines.json, so this is never
// guessed and adding a channel needs no code change.
const parentOf = code => airlineResolver.getAirline(code)?.parent;

// The Akbar B2B flow is carrier-agnostic — every airline config in this repo carries the same
// source/mode/url keys, and adapters exist only to add carrier quirks on top. These are the
// shared defaults used to synthesise an adapter for a registered carrier that has no plugin.
const B2B_DEFAULTS = {
  country: 'India',
  authUrlEnvKey: 'UtilsURLTest',
  flightUrlEnvKey: 'FlightURLTest',
  // ExpressSearch lives on its own subdomain in B2C, separate from the rest of the Flight API —
  // confirmed live in Phase 1 (docs/changes/2026-09-17-phase1-core-flow-live-verification.md).
  avlUrlEnvKey: 'AvlURLTest',
  defaultCabinClass: 'E',
  fareTypes: { DOM: 'ON', INT: 'IN' },
  source: 'CF',
  mode: 'AS',
  smartPricerSource: 'SF'
};

class AirlineRegistry {
  constructor() {
    this._adapters = {};
    this._generic = {};        // synthesised adapters, cached by code
    this._warnedGeneric = {};  // so the "no adapter" notice is logged once per code
    this._loaded = false;
  }

  /**
   * Load all airline adapters from the airlines/ directory.
   * Skips the 'base' folder (abstract classes).
   */
  loadAll() {
    if (this._loaded) return;

    const airlinesDir = path.join(__dirname);
    const entries = fs.readdirSync(airlinesDir, { withFileTypes: true });

    entries.forEach(entry => {
      if (!entry.isDirectory()) return;
      if (entry.name === 'base') return; // skip abstract base

      const adapterPath = path.join(airlinesDir, entry.name, 'adapter.js');
      if (!fs.existsSync(adapterPath)) return;

      try {
        const adapter = require(adapterPath);
        this._adapters[adapter.iataCode] = adapter;
        console.log(`[AirlineRegistry] Loaded: ${adapter.iataCode} (${adapter.name})`);
      } catch (err) {
        console.error(`[AirlineRegistry] Failed to load adapter at ${adapterPath}: ${err.message}`);
      }
    });

    this._loaded = true;
  }

  /**
   * Synthesise a carrier-agnostic B2B adapter for a registered airline that has no plugin of
   * its own. It carries THAT carrier's identity and capabilities — never another's.
   * @private
   */
  _genericAdapter(code) {
    if (this._generic[code]) return this._generic[code];

    const BaseAirlineAdapter = require('./base/BaseAirlineAdapter');

    // The marketplace pseudo-carrier has no profile — it searches every airline.
    const profile = airlineResolver.getAirline(code) || {
      Name: 'Akbar B2B Marketplace', IsLcc: false, supportsMC: true, sectorTypes: ['DOM', 'INT']
    };

    const tripTypes = ['OW', 'RT'];
    if (profile.supportsMC) tripTypes.push('MC');

    const adapter = new BaseAirlineAdapter({
      ...B2B_DEFAULTS,
      iataCode: code,
      name: profile.Name || code,
      type: profile.IsLcc ? 'LCC' : 'GDS',
      supportedSectorTypes: profile.sectorTypes || ['DOM'],
      supportedTripTypes: tripTypes,
      tags: [code]
    });

    this._generic[code] = adapter;
    return adapter;
  }

  /**
   * Get the adapter for an airline.
   *
   * `iataCode` may be a single code ('6E'), a comma-separated marketplace list
   * ('6E, AI, SG'), or empty (marketplace, all airlines). A marketplace search is not tied to
   * one carrier, so it gets the generic B2B adapter rather than an arbitrary carrier's.
   *
   * A code that is registered in configs/airlines.json but has no airlines/<CODE>/adapter.js
   * gets a synthesised generic adapter carrying its own identity — it does NOT silently inherit
   * another carrier's adapter, which would apply that carrier's quirks and identity to it.
   *
   * An unknown code throws (dev rule 4: fail fast).
   *
   * @param {string} iataCode
   * @returns {BaseAirlineAdapter}
   */
  resolve(iataCode) {
    if (!this._loaded) this.loadAll();

    const raw = (iataCode || '').toUpperCase().trim();

    // Marketplace: no airline, or a list of them. The flow is identical for every carrier, so
    // use the generic adapter rather than letting one carrier's plugin stand in for all.
    if (raw === '' || raw.includes(',')) {
      return this._genericAdapter(MARKETPLACE_CODE);
    }

    const code = parentOf(raw) || raw;

    // 1. A real plugin for this carrier (or the carrier it is a channel of).
    if (this._adapters[code]) return this._adapters[code];

    // 2. Registered carrier, no plugin — synthesise one with its own identity.
    if (airlineResolver.getAirline(code)) {
      if (!this._warnedGeneric[code]) {
        console.log(`[AirlineRegistry] No adapter for ${code} — using the generic B2B adapter. ` +
          `Create airlines/${code}/adapter.js if it needs carrier-specific behaviour.`);
        this._warnedGeneric[code] = true;
      }
      return this._genericAdapter(code);
    }

    // 3. Unknown to the platform entirely.
    throw new Error(
      `[AirlineRegistry] Unknown airline "${iataCode}". It is not registered in ` +
      `configs/airlines.json and has no adapter. Registered: ${airlineResolver.getAllKnownCodes().join(', ')}. ` +
      `Adapters: ${Object.keys(this._adapters).join(', ')}.`
    );
  }

  /**
   * Returns all registered airline codes.
   * @returns {string[]}
   */
  getRegisteredAirlines() {
    if (!this._loaded) this.loadAll();
    return Object.keys(this._adapters);
  }
}

module.exports = new AirlineRegistry();
