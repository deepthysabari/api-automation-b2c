'use strict';

const fs = require('fs');
const path = require('path');
const airlineResolver = require('./airlineResolver');

/**
 * SectorResolutionEngine — Scalable route management and selection.
 *
 * Replaces hardcoded origin/destination pairs with dynamic, metadata-driven 
 * sector pools. Supports random, round-robin, and full-matrix selection strategies.
 */
class SectorResolutionEngine {
  constructor() {
    this.pools = {};
    this.cursors = {}; // For ROUND_ROBIN state tracking
    this.poolsDir = path.join(__dirname, '../config/sectorPools');
    this._loadPools();
  }

  /**
   * Load and validate all sector pool JSONs on startup.
   */
  _loadPools() {
    if (!fs.existsSync(this.poolsDir)) {
      console.warn(`[SectorEngine] Pools directory not found: ${this.poolsDir}`);
      return;
    }

    const files = fs.readdirSync(this.poolsDir).filter(f => f.endsWith('.json'));
    
    for (const file of files) {
      try {
        const filePath = path.join(this.poolsDir, file);
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        
        if (!data.poolName || !data.routes || !Array.isArray(data.routes)) {
          throw new Error(`Invalid pool schema in ${file}`);
        }

        this.pools[data.poolName] = data;
        this.cursors[data.poolName] = 0; // Initialize round-robin cursor

      } catch (err) {
        console.error(`[SectorEngine] Failed to load pool ${file}: ${err.message}`);
        process.exit(1); // Fail fast on invalid config
      }
    }
  }

  /**
   * Resolve routes for a given scenario definition.
   * 
   * @param {Object} scenarioDef - The scenario definition JSON
   * @returns {Object[]} An array of resolved route objects (multiple if strategy = ALL)
   */
  resolve(scenarioDef) {
    const { dataset, dimensions } = scenarioDef;
    
    // 1. Backward Compatibility: If explicit origin/dest exist, use them directly
    if (dataset.origin && dataset.destination) {
      return [{
        origin: dataset.origin,
        destination: dataset.destination,
        _isHardcoded: true
      }];
    }
    if (dataset.sectors && Array.isArray(dataset.sectors) && !dataset.sectorPool) {
      return [{
        sectors: dataset.sectors,
        _isHardcoded: true
      }];
    }

    // 2. Validate Pool Configuration
    const poolName = dataset.sectorPool;
    if (!poolName) {
      throw new Error(`Scenario ${scenarioDef.id} must define 'dataset.sectorPool' or explicit origin/destination.`);
    }

    const pool = this.pools[poolName];
    if (!pool) {
      throw new Error(`Sector pool '${poolName}' not found. Available pools: ${Object.keys(this.pools).join(', ')}`);
    }

    const strategy = dataset.selectionStrategy || 'RANDOM';
    const searchMode = airlineResolver.resolveSearchMode(scenarioDef);
    // Scoped to searchMode === 'preferred' specifically, not just "is dimensions.airline set" —
    // a marketplace scenario's "validate airlines X, Y are present" step also sets
    // dimensions.airline (to the full comma-separated expected list, for
    // availabilityValidator's own use), so trusting it unconditionally here would try to
    // route-scope a common/marketplace scenario using that whole list as if it were one
    // carrier code. searchMode === 'preferred' is the real signal that this scenario named ONE
    // specific carrier to search around (bddInterpreter sets both together). Note this is about
    // WHICH SECTOR to search, not whether the request itself gets filtered — B2C's
    // ExpressSearch never filters by carrier regardless (see BaseAirlineAdapter.getFlowSteps).
    const airline = searchMode === 'preferred' ? dimensions.airline : '';
    const tripType = dimensions.tripType;

    // 2.1 Enforce Airline Resolution Sector validations
    if (airline) {
      const isSupported = airlineResolver.isAirlineSupportedOnSector(airline, dimensions.sectorType);
      if (!isSupported) {
        throw new Error(`[SectorEngine] Selected airline '${airline}' does not support sector type '${dimensions.sectorType}'`);
      }
    }

    // 3. Filter Eligible Routes
    const routeAirline = airlineResolver.baseCarrier(airline);
    let eligibleRoutes = pool.routes.filter(route => {
      // Must support the requested airline
      if (routeAirline && route.airlines && !route.airlines.includes(routeAirline)) {
        return false;
      }
      // Marketplace (no specific airline requested) must not land on a thin/niche route —
      // whether it's single-carrier (e.g. NDC-BLR only flies S5, JLG-* only flies IC) or just
      // low-volume with a narrower carrier/provider mix than the rest of the pool (e.g. B2C's
      // IXE-DXB/IXE-AUH: 2 carriers each, but neither carries SB/1G, unlike every other
      // international route — a random pick landing there broke Shape A's "SB"/"1G" provider
      // assertions even though they're 2-carrier, not single-carrier; reproduced live
      // 2026-09-22). `category: "low_frequency"` alone is the signal now, not carrier count —
      // any route marked this way is a general-availability outlier and should only be reached
      // via an explicit preferred search for a carrier it actually carries.
      if (!routeAirline && route.category === 'low_frequency') {
        return false;
      }
      return true;
    });

    if (dimensions && dimensions.cabinClass === 'B') {
      const config = require('../config/config');
      eligibleRoutes = eligibleRoutes.filter(route => {
        const routeKey = `${route.origin}-${route.destination}`;
        const reverseRouteKey = `${route.destination}-${route.origin}`;
        const premiumRoutes = config.premiumSupportedRoutes || [];
        return premiumRoutes.includes(routeKey) || premiumRoutes.includes(reverseRouteKey);
      });
    }

    if (eligibleRoutes.length === 0) {
      // Live-only: no synthetic fallback. A pool with no route carrying live
      // inventory for this airline is a configuration gap — fail fast so it is
      // fixed in the sector pool, not papered over with a fabricated route.
      throw new Error(`No eligible routes found in pool '${poolName}' for airline '${airline}'`);
    }

    // 4. Handle Selection Strategies
    if (tripType === 'MC' && poolName === 'domestic') {
      // Dynamic Stitching for Domestic MC (select 2 distinct routes)
      return [this._stitchDynamicMulticity(eligibleRoutes, strategy, poolName, dataset)];
    }

    const selected = this._selectRoutes(eligibleRoutes, strategy, poolName);
    return selected.map(route => {
      if (route && Array.isArray(route.sectors)) {
        return {
          ...route,
          sectors: route.sectors.map((sec, idx) => ({
            ...sec,
            date: sec.date || (idx === 0 ? (dataset.onwardDate || '{{futureDate:3}}') : (dataset.returnDate || `{{futureDate:${3 + idx * 4}}}`))
          }))
        };
      }
      return route;
    });
  }

  /** @private Select routes based on strategy */
  _selectRoutes(routes, strategy, poolName) {
    if (strategy === 'ALL') {
      return routes; // Return all for matrix generation
    }

    if (strategy === 'ROUND_ROBIN') {
      const index = this.cursors[poolName] % routes.length;
      this.cursors[poolName]++;
      return [routes[index]];
    }

    // Default: RANDOM
    const randomIndex = Math.floor(Math.random() * routes.length);
    return [routes[randomIndex]];
  }

  /** @private Dynamically stitch oneway routes into a multicity array */
  _stitchDynamicMulticity(routes, strategy, poolName, dataset) {
    const preferredMetros = ['DEL', 'BOM', 'BLR', 'HYD', 'MAA', 'CCU', 'COK'];
    
    // Determine if regional is allowed/requested
    const allowRegional = dataset.allowRegional === true;
    
    let poolRoutes = routes;
    if (!allowRegional) {
      // Filter routes to only those involving preferred metro airports
      const filtered = routes.filter(r => preferredMetros.includes(r.origin) && preferredMetros.includes(r.destination));
      if (filtered.length >= 1) {
        poolRoutes = filtered;
      }
    }

    if (poolRoutes.length === 0) {
      throw new Error(`Not enough eligible routes in pool '${poolName}' to stitch a Multicity trip.`);
    }

    let r1, r2;

    if (strategy === 'ROUND_ROBIN') {
      r1 = poolRoutes[this.cursors[poolName] % poolRoutes.length];
      this.cursors[poolName]++;
      
      // Try to find a connecting route in poolRoutes
      r2 = poolRoutes.find(r => r.origin === r1.destination && r.destination !== r1.origin);
      if (!r2) {
        // Construct a connecting sector dynamically using preferred metros
        const allowedDestinations = preferredMetros.filter(code => code !== r1.origin && code !== r1.destination);
        const dest = allowedDestinations[this.cursors[poolName] % allowedDestinations.length];
        this.cursors[poolName]++;
        r2 = {
          origin: r1.destination,
          destination: dest,
          airlines: r1.airlines,
          domestic: r1.domestic,
          international: r1.international
        };
      }
    } else {
      // RANDOM
      r1 = poolRoutes[Math.floor(Math.random() * poolRoutes.length)];
      r2 = poolRoutes.find(r => r.origin === r1.destination && r.destination !== r1.origin);
      if (!r2) {
        // Construct a connecting sector dynamically
        const allowedDestinations = preferredMetros.filter(code => code !== r1.origin && code !== r1.destination);
        const dest = allowedDestinations[Math.floor(Math.random() * allowedDestinations.length)];
        r2 = {
          origin: r1.destination,
          destination: dest,
          airlines: r1.airlines,
          domestic: r1.domestic,
          international: r1.international
        };
      }
    }

    return {
      type: 'dynamic_stitched',
      sectors: [
        { origin: r1.origin, destination: r1.destination, date: dataset.onwardDate || '{{futureDate:3}}' },
        { origin: r2.origin, destination: r2.destination, date: dataset.returnDate || '{{futureDate:7}}' }
      ]
    };
  }
}

module.exports = new SectorResolutionEngine();
