'use strict';

const dataGenerator = require('../utils/dataGenerator');
const airlineRegistry = require('../airlines/registry');
const sectorEngine = require('../engine/sectorResolutionEngine');

/**
 * ScenarioGenerator — Builds executable test cases from scenario definitions.
 *
 * Takes a scenario definition (JSON) + the matching airline adapter and
 * produces a fully-resolved test case object ready for the runner.
 *
 * Responsibilities:
 *   1. Resolve date placeholders in dataset ({{futureDate:N}})
 *   2. Delegate step generation to the airline adapter
 *   3. Merge scenario-level validators with step-level validators
 *   4. Attach scenario metadata to the test case for reporting
 */
class ScenarioGenerator {
  /**
   * Build one or more runnable test cases from a scenario definition.
   * @param {Object} scenario - Scenario definition from definitions/*.json
   * @returns {Object[]} Array of runnable test cases (multiple if ALL strategy is used)
   */
  build(scenario) {
    // Resolve external test data if dataRef is specified
    let targetScenario = { ...scenario };
    if (scenario.dataset && scenario.dataset.dataRef) {
      const fs = require('fs');
      const path = require('path');
      
      let refPath = scenario.dataset.dataRef;
      // Interpolate dimensions (like {{airline}} or {{sectorType}} etc) if they exist in the path string
      if (scenario.dimensions) {
        for (const [dimKey, dimVal] of Object.entries(scenario.dimensions)) {
          if (typeof dimVal === 'string') {
            refPath = refPath.replace(new RegExp(`{{${dimKey}}}`, 'g'), dimVal.toLowerCase());
          }
        }
      }

      let dataRefPath = path.join(__dirname, '../testdata', `${refPath}.json`);
      if (!fs.existsSync(dataRefPath)) {
        // Fall back to a common version without airline folders if possible, e.g. availability/oneway_search.json
        const fallbackRef = scenario.dataset.dataRef.replace('{{airline}}/', '');
        const fallbackPath = path.join(__dirname, '../testdata', `${fallbackRef}.json`);
        if (fs.existsSync(fallbackPath)) {
          dataRefPath = fallbackPath;
        }
      }

      if (fs.existsSync(dataRefPath)) {
        const testData = JSON.parse(fs.readFileSync(dataRefPath, 'utf8'));
        // Merge test data into dataset, giving precedence to scenario-level dataset overrides
        targetScenario.dataset = { ...testData, ...scenario.dataset };
        delete targetScenario.dataset.dataRef;
      } else {
        throw new Error(`[ScenarioGenerator] Referenced test data file not found: ${dataRefPath}`);
      }
    }

    // 1. Resolve the airline adapter
    const adapter = airlineRegistry.resolve(targetScenario.dimensions.airline);

    // 2. Resolve eligible routes via Sector Pool Engine
    const resolvedRoutes = sectorEngine.resolve(targetScenario);
    
    let routes = resolvedRoutes;
    if (targetScenario.dimensions && targetScenario.dimensions.airline === '6E' && targetScenario.dimensions.cabinClass === 'B') {
      const config = require('../config/config');
      routes = resolvedRoutes.filter(route => {
        const premiumRoutes = config.premiumSupportedRoutes || [];
        if (route.origin && route.destination) {
          const routeKey = `${route.origin}-${route.destination}`;
          const reverseRouteKey = `${route.destination}-${route.origin}`;
          const isSupported = premiumRoutes.includes(routeKey) || premiumRoutes.includes(reverseRouteKey);
          if (!isSupported) {
            console.log(`[Generator] Skipping Cabin B scenario build for route ${route.origin}→${route.destination} (not premium-supported).`);
          }
          return isSupported;
        } else if (route.sectors && Array.isArray(route.sectors)) {
          const allSupported = route.sectors.every(sec => {
            const secKey = `${sec.origin}-${sec.destination}`;
            const revSecKey = `${sec.destination}-${sec.origin}`;
            return premiumRoutes.includes(secKey) || premiumRoutes.includes(revSecKey);
          });
          if (!allSupported) {
            console.log(`[Generator] Skipping Cabin B scenario build for multicity routes (not premium-supported).`);
          }
          return allSupported;
        }
        return true;
      });
    }

    return routes.map(route => {
      // Create a dataset specific to this route
      const routeDataset = { ...targetScenario.dataset, ...route };
      const resolvedDataset = this._resolveDataset(routeDataset);

      // Build a fully resolved scenario clone
      const resolvedScenario = {
        ...targetScenario,
        dataset: resolvedDataset
      };

      // Generate a dynamic ID if it's expanding a matrix (e.g., ALL strategy)
      let testCaseId = targetScenario.id;
      if (!route._isHardcoded && resolvedRoutes.length > 1) {
        if (route.origin && route.destination) {
          testCaseId = `${targetScenario.id}_${route.origin}_${route.destination}`;
        } else if (route.sectors) {
          testCaseId = `${targetScenario.id}_MC_EXPANDED`;
        }
      }

      // 3. Get step definitions from the airline adapter
      const steps = adapter.getFlowSteps(resolvedScenario);

      // 4. Determine which validators to run
      const scenarioValidators = (targetScenario.validations && targetScenario.validations.validators) || [];
      const airlineValidators  = adapter.getAirlineValidators();
      const allValidators = [...new Set([...scenarioValidators, ...airlineValidators])];

      return {
        id:          testCaseId,
        name:        targetScenario.name,
        tags:        targetScenario.tags,
        priority:    targetScenario.priority,
        retries:     targetScenario.retries || 0,
        scenario:    resolvedScenario,
        steps:       steps,
        validators:  allValidators,
        adapter:     adapter,
        _meta: {
          airline:      targetScenario.dimensions.airline,
          sectorType:   targetScenario.dimensions.sectorType,
          tripType:     targetScenario.dimensions.tripType,
          passengerMix: targetScenario.dimensions.passengerMix,
          cabinClass:   targetScenario.dimensions.cabinClass || 'E',
          fareType:     targetScenario.dimensions.fareType,
          poolName:     targetScenario.dataset.sectorPool || 'hardcoded',
          routeInfo:    route.origin ? `${route.origin} → ${route.destination}` : 'Multicity Route',
          routeCategory:route.category || 'N/A'
        }
      };
    });
  }

  /**
   * Build multiple test cases from an array of scenarios.
   * @param {Object[]} scenarios
   * @returns {Object[]}
   */
  buildAll(scenarios) {
    return scenarios.flatMap(s => {
      try {
        return this.build(s);
      } catch (err) {
        throw new Error(`[ScenarioGenerator] Failed to build scenario '${s.id}': ${err.message}`);
      }
    });
  }

  /**
   * Resolve dataset placeholders.
   * Supports {{futureDate:N}} where N is days from today.
   * @private
   */
  _resolveDataset(dataset) {
    const resolved = JSON.parse(JSON.stringify(dataset)); // deep clone
    return this._resolvePlaceholders(resolved);
  }

  /** @private — Recursively resolve placeholders in any object */
  _resolvePlaceholders(obj) {
    if (typeof obj === 'string') {
      return this._resolveString(obj);
    }
    if (Array.isArray(obj)) {
      return obj.map(item => this._resolvePlaceholders(item));
    }
    if (obj && typeof obj === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(obj)) {
        out[k] = this._resolvePlaceholders(v);
      }
      return out;
    }
    return obj;
  }

  /** @private — Resolve a single string with placeholders */
  _resolveString(str) {
    return str.replace(/\{\{(\w+)(?::(\d+))?\}\}/g, (match, key, arg) => {
      if (key === 'futureDate') {
        const days = arg ? parseInt(arg, 10) : 3;
        return this._futureDate(days);
      }
      // Fall through to dataGenerator for other keys
      const generated = dataGenerator.resolve(`{{${key}}}`);
      return generated !== `{{${key}}}` ? generated : match;
    });
  }

  /** @private — Returns YYYY-MM-DD N days from today */
  _futureDate(days) {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return d.toISOString().split('T')[0];
  }
}

module.exports = new ScenarioGenerator();
