'use strict';

const fs = require('fs');
const path = require('path');

class MatrixGenerator {
  constructor() {
    this._configs = {};
    this._loaded = false;
  }

  /**
   * Load and validate all matrix configuration files on framework startup.
   * Throws an error immediately (fail-fast) if any validator checks fail.
   */
  init() {
    if (this._loaded) return this;

    const matrixDir = path.join(__dirname, '../config/matrix');
    if (!fs.existsSync(matrixDir)) {
      throw new Error(`[MatrixGenerator] Matrix config directory not found at: ${matrixDir}`);
    }

    // 1. Load files
    const files = {
      airlines: 'airlines.json',
      tripTypes: 'tripTypes.json',
      paxMix: 'paxMix.json',
      ssr: 'ssr.json',
      fareFamilies: 'fareFamilies.json',
      executionProfiles: 'executionProfiles.json'
    };

    for (const [key, filename] of Object.entries(files)) {
      const filePath = path.join(matrixDir, filename);
      if (!fs.existsSync(filePath)) {
        throw new Error(`[MatrixGenerator] Missing required matrix configuration file: ${filename}`);
      }
      try {
        this._configs[key] = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      } catch (err) {
        throw new Error(`[MatrixGenerator] Failed to parse ${filename}: ${err.message}`);
      }
    }

    // 2. Execute Startup Validations
    this._validateDuplicateValues();
    this._validateMissingCapabilities();
    this._validateExecutionProfiles();

    this._loaded = true;
    return this;
  }

  /**
   * Generate executable scenario structures based on requested profile.
   * @param {string} [profileName] - Profile to execute (defaults to smoke or nightly)
   * @returns {{ scenarios: Object[], summary: Object }}
   */
  generate(profileName = 'smoke') {
    if (!this._loaded) this.init();

    const profile = this._configs.executionProfiles[profileName];
    if (!profile) {
      throw new Error(`[MatrixGenerator] Execution profile not found: "${profileName}"`);
    }

    const { sectorPools, tripTypes, paxMixes, airlines, ssr, fareProducts, maxScenarios = 50 } = profile;

    let combinationsCount = 0;
    let skippedMC = 0;
    let skippedInfant = 0;
    let skippedSSR = 0;
    let skippedFareFamily = 0;
    let skippedLccBusiness = 0;
    let skippedInternationalMC = 0;

    const validScenarios = [];

    // Cartesian product loop
    for (const pool of sectorPools) {
      for (const trip of tripTypes) {
        for (const paxKey of paxMixes) {
          for (const air of airlines) {
            for (const ssrKey of ssr) {
              // Retrieve dimension objects
              const paxMixObj = this._configs.paxMix.find(p => p.id === paxKey);
              const ssrObj = this._configs.ssr.find(s => s.id === ssrKey);
              const capability = this._configs.airlines[air];

              if (!paxMixObj || !capability) continue;

              // 1. Skip Multicity (MC) if not supported by airline
              if (trip === 'MC' && (!capability || capability.supportsMC === false)) {
                skippedMC++;
                continue;
              }

              // 2. Skip Infant mixes if infant not supported by airline
              const hasInfant = paxMixObj.pax && paxMixObj.pax.INF > 0;
              if (hasInfant && (!capability || capability.supportsInfant === false)) {
                skippedInfant++;
                continue;
              }

              // 3. Skip SSR mixes (other than NONE) if SSR not supported by airline
              if (ssrKey !== 'NONE' && (!capability || capability.supportsSSR === false)) {
                skippedSSR++;
                continue;
              }

              // 4. Skip International Multicity if multicity pool doesn't match
              const isInternational = pool === 'international';
              if (isInternational && trip === 'MC') {
                skippedInternationalMC++;
                continue;
              }

              // 5. Skip if the airline does not support the sector type (e.g. DOM vs INT)
              const sectorType = pool === 'domestic' ? 'DOM' : 'INT';
              if (capability.sectorTypes && !capability.sectorTypes.includes(sectorType)) {
                continue;
              }

              // Retrieve and loop through configured cabins and fare products
              const cabins = capability.cabins || {};
              for (const [cabinCode, cabinConfig] of Object.entries(cabins)) {
                const products = cabinConfig.fareProducts || [];

                for (const fareProduct of products) {
                  combinationsCount++;

                  // Check if this fare product is requested in the execution profile
                  const isIncluded = fareProducts.some(p => 
                    p.toLowerCase() === fareProduct.fcType.toLowerCase()
                  );
                  if (!isIncluded) {
                    skippedFareFamily++;
                    continue;
                  }

                  // Clean the fare product name for tags and scenario ID
                  const productNameClean = fareProduct.fcType.toUpperCase()
                    .replace(/\s*FARE/gi, '')
                    .replace(/[^A-Z0-9]/g, '');

                  // Build scenario ID: DOM_OW_1ADT_6E_E_SAVER
                  // Append SSR if not NONE
                  const ssrSuffix = ssrKey !== 'NONE' ? `_${ssrKey}` : '';
                  const scenarioId = `MATRIX_${sectorType}_${trip}_${paxKey}_${air}_${cabinCode}_${productNameClean}${ssrSuffix}`;

                  // Form tags list dynamically
                  const tags = [
                    pool,
                    trip === 'OW' ? 'oneway' : (trip === 'RT' ? 'roundtrip' : 'multicity'),
                    air.toLowerCase(),
                    cabinCode.toLowerCase(),
                    fareProduct.fcType.toLowerCase().replace(/\s+/g, ''),
                    'matrix',
                    profileName
                  ];
                  if (ssrObj && ssrObj.tags) tags.push(...ssrObj.tags);

                  // Build the executable scenario JSON-like structure
                  const scenario = {
                    id: scenarioId,
                    name: `${sectorType} ${trip} - ${paxKey} - ${air} - ${cabinCode} - ${fareProduct.fcType}${ssrKey !== 'NONE' ? ` [SSR: ${ssrKey}]` : ''}`,
                    tags: [...new Set(tags)],
                    priority: profileName === 'smoke' ? 1 : 2,
                    dimensions: {
                      sectorType: sectorType,
                      tripType: trip,
                      passengerMix: paxMixObj.pax,
                      airline: air,
                      cabinClass: cabinCode,
                      fareType: trip === 'RT' ? 'RT' : 'ON',
                      environment: 'beta',
                      fcType: fareProduct.fcType,
                      fareClass: fareProduct.fareClass
                    },
                    dataset: {
                      sectorPool: pool,
                      selectionStrategy: profileName === 'smoke' ? 'RANDOM' : 'ROUND_ROBIN',
                      onwardDate: '{{futureDate:3}}',
                      returnDate: '{{futureDate:7}}'
                    },
                    flow: 'standardBookingFlow',
                    validations: {
                      validators: ['business', 'pricing', 'segment', 'passenger']
                    },
                    ssrType: ssrKey,
                    // Save custom properties for backward compatibility
                    fareFamily: fareProduct.fcType,
                    fcType: fareProduct.fcType,
                    fareClass: fareProduct.fareClass
                  };

                  validScenarios.push(scenario);
                }
              }
            }
          }
        }
      }
    }

    // Explosion Control: Clamping to maximum scenarios
    const originalCount = validScenarios.length;
    let generatedScenarios = validScenarios;
    let skippedByExplosion = 0;

    if (originalCount > maxScenarios) {
      // Intelligently sample scenarios to fit the threshold
      generatedScenarios = validScenarios.slice(0, maxScenarios);
      skippedByExplosion = originalCount - maxScenarios;
    }

    const summary = {
      profile: profileName,
      totalCombinationsEvaluated: combinationsCount,
      totalValidGenerated: generatedScenarios.length,
      skippedMC,
      skippedInfant,
      skippedSSR,
      skippedFareFamily,
      skippedLccBusiness,
      skippedInternationalMC,
      skippedByExplosion
    };

    return { scenarios: generatedScenarios, summary };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Startup Validation Rules (Fail-Fast Checks)
  // ─────────────────────────────────────────────────────────────────────────

  /** @private - Throws error if any dimension array has duplicate ID values */
  _validateDuplicateValues() {
    const dimensions = ['tripTypes', 'paxMix', 'ssr'];
    for (const dim of dimensions) {
      const list = this._configs[dim];
      if (!Array.isArray(list)) continue;

      const ids = list.map(item => item.id);
      const uniqueIds = new Set(ids);
      if (uniqueIds.size !== ids.length) {
        const duplicates = ids.filter((item, index) => ids.indexOf(item) !== index);
        throw new Error(`[MatrixGenerator][Startup Validation] Duplicate values found in config/matrix/${dim}.json for ID: "${duplicates.join(', ')}"`);
      }
    }
  }

  /** @private - Throws error if cabins or fare products are invalidly structured */
  _validateMissingCapabilities() {
    const registry = this._configs.airlines;

    for (const [airline, config] of Object.entries(registry)) {
      if (!config.cabins || typeof config.cabins !== 'object') {
        throw new Error(`[MatrixGenerator][Startup Validation] Airline "${airline}" is missing required "cabins" configuration object.`);
      }

      for (const [cabinCode, cabin] of Object.entries(config.cabins)) {
        if (!Array.isArray(cabin.fareProducts) || cabin.fareProducts.length === 0) {
          throw new Error(`[MatrixGenerator][Startup Validation] Airline "${airline}" cabin "${cabinCode}" has missing or empty "fareProducts" array.`);
        }

        const fcTypes = cabin.fareProducts.map(fp => fp.fcType);
        const uniqueFcTypes = new Set(fcTypes);

        if (uniqueFcTypes.size !== fcTypes.length) {
          throw new Error(`[MatrixGenerator][Startup Validation] Airline "${airline}" cabin "${cabinCode}" has duplicate "fcType" values.`);
        }
      }
    }
  }

  /** @private - Throws error if execution profiles reference invalid or unregistered values */
  _validateExecutionProfiles() {
    const registry = this._configs.airlines;
    const profiles = this._configs.executionProfiles;
    const tripTypeIds = this._configs.tripTypes.map(t => t.id);
    const paxMixIds = this._configs.paxMix.map(p => p.id);
    const airlineIds = Object.keys(registry);
    const ssrIds = this._configs.ssr.map(s => s.id);

    // Extract all registered fare products across all airlines
    const registeredFareProducts = [];
    for (const airConfig of Object.values(registry)) {
      for (const cabin of Object.values(airConfig.cabins || {})) {
        for (const fp of cabin.fareProducts || []) {
          registeredFareProducts.push(fp.fcType.toLowerCase());
        }
      }
    }

    for (const [profileName, prof] of Object.entries(profiles)) {
      // Validate tripTypes
      for (const t of prof.tripTypes || []) {
        if (!tripTypeIds.includes(t)) {
          throw new Error(`[MatrixGenerator][Startup Validation] Profile "${profileName}" references unregistered TripType: "${t}"`);
        }
      }
      // Validate paxMixes
      for (const p of prof.paxMixes || []) {
        if (!paxMixIds.includes(p)) {
          throw new Error(`[MatrixGenerator][Startup Validation] Profile "${profileName}" references unregistered PaxMix: "${p}"`);
        }
      }
      // Validate airlines
      for (const a of prof.airlines || []) {
        if (!airlineIds.includes(a)) {
          throw new Error(`[MatrixGenerator][Startup Validation] Profile "${profileName}" references unregistered Airline: "${a}"`);
        }
      }
      // Validate ssr
      for (const s of prof.ssr || []) {
        if (!ssrIds.includes(s)) {
          throw new Error(`[MatrixGenerator][Startup Validation] Profile "${profileName}" references unregistered SSR: "${s}"`);
        }
      }
      // Validate fareProducts
      for (const fp of prof.fareProducts || []) {
        if (!registeredFareProducts.includes(fp.toLowerCase())) {
          throw new Error(`[MatrixGenerator][Startup Validation] Profile "${profileName}" references unregistered Fare Product: "${fp}"`);
        }
      }
    }
  }
}

module.exports = new MatrixGenerator();
