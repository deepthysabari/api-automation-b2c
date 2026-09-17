'use strict';

const fs = require('fs');
const path = require('path');
const tagFilter = require('../utils/tagFilter');

/**
 * ScenarioFilter — Dynamic scenario selection engine.
 *
 * Reads filter criteria from environment variables or explicit options
 * and returns only the matching scenarios.
 *
 * Supported filter dimensions:
 *   SUITE=smoke            → run named suite from suites/
 *   TAGS=smoke,domestic|int,~6E → match using advanced AND/OR/NOT logic
 *   AIRLINE=6E             → filter by dimensions.airline
 *   TRIP_TYPE=OW           → filter by dimensions.tripType
 *   SECTOR_TYPE=DOM        → filter by dimensions.sectorType
 *   PRIORITY=1             → only priority <= this value
 *   SCENARIO_IDS=DOM_OW_1ADT_6E,INT_OW_1ADT_6E → specific IDs
 *   RERUN_FAILED=true      → re-run scenarios that failed in last report
 *   ENV=beta               → filter by dimensions.environment
 */
class ScenarioFilter {
  /**
   * Apply all active filters and return matching scenarios.
   * @param {Object[]} allScenarios - All loaded scenario definitions
   * @param {Object} [overrides]    - Direct option overrides (for CLI usage)
   * @returns {Object[]} Filtered, sorted list of scenarios to run
   */
  apply(allScenarios, overrides = {}) {
    const opts = this._resolveOptions(overrides);
    let scenarios = [...allScenarios];

    // 1. Suite filter — load scenario IDs from suite JSON
    if (opts.suite) {
      const suiteIds = this._loadSuite(opts.suite);
      scenarios = scenarios.filter(s => suiteIds.includes(s.id));
      console.log(`[Filter] Suite "${opts.suite}" → ${scenarios.length} scenarios`);
    }

    // 2. Specific scenario IDs
    if (opts.scenarioIds && opts.scenarioIds.length > 0) {
      scenarios = scenarios.filter(s => opts.scenarioIds.includes(s.id));
      console.log(`[Filter] Scenario IDs → ${scenarios.length} scenarios`);
    }

    // 3. Tag filter using TagFilter engine
    if (opts.tagsExpression) {
      scenarios = scenarios.filter(s => tagFilter.evaluate(opts.tagsExpression, s.tags));
      console.log(`[Filter] Tags expression "${opts.tagsExpression}" → ${scenarios.length} scenarios`);
    }

    // 4. Airline filter
    if (opts.airline) {
      scenarios = scenarios.filter(s => s.dimensions.airline === opts.airline);
      console.log(`[Filter] Airline "${opts.airline}" → ${scenarios.length} scenarios`);
    }

    // 5. Trip type filter
    if (opts.tripType) {
      scenarios = scenarios.filter(s => s.dimensions.tripType === opts.tripType.toUpperCase());
      console.log(`[Filter] TripType "${opts.tripType}" → ${scenarios.length} scenarios`);
    }

    // 6. Sector type filter
    if (opts.sectorType) {
      scenarios = scenarios.filter(s => s.dimensions.sectorType === opts.sectorType.toUpperCase());
      console.log(`[Filter] SectorType "${opts.sectorType}" → ${scenarios.length} scenarios`);
    }

    // 7. Priority filter
    if (opts.priority !== null) {
      scenarios = scenarios.filter(s => (s.priority || 99) <= opts.priority);
      console.log(`[Filter] Priority <= ${opts.priority} → ${scenarios.length} scenarios`);
    }

    // 8. Environment filter
    if (opts.env) {
      scenarios = scenarios.filter(s =>
        !s.dimensions.environment || s.dimensions.environment === opts.env
      );
    }

    // 9. Rerun failed — load IDs from last failed report
    if (opts.rerunFailed) {
      const failedIds = this._loadFailedScenarioIds();
      scenarios = scenarios.filter(s => failedIds.includes(s.id));
      console.log(`[Filter] Rerun failed → ${scenarios.length} scenarios`);
    }

    // Final sort by priority
    scenarios.sort((a, b) => (a.priority || 99) - (b.priority || 99));

    if (scenarios.length === 0) {
      console.warn('[Filter] ⚠️  No scenarios matched the active filters.');
    } else {
      console.log(`[Filter] ✅ ${scenarios.length} scenario(s) selected for execution`);
    }

    return scenarios;
  }

  /** @private — Merge env vars + overrides into option object */
  _resolveOptions(overrides) {
    return {
      suite:          overrides.suite       || process.env.SUITE       || null,
      tagsExpression: overrides.tags        || process.env.TAGS        || '',
      airline:        overrides.airline     || process.env.AIRLINE     || null,
      tripType:       overrides.tripType    || process.env.TRIP_TYPE   || null,
      sectorType:     overrides.sectorType  || process.env.SECTOR_TYPE || null,
      priority:       this._parseNum(overrides.priority || process.env.PRIORITY),
      scenarioIds:    this._parseList(overrides.scenarioIds || process.env.SCENARIO_IDS),
      rerunFailed:    overrides.rerunFailed || process.env.RERUN_FAILED === 'true',
      env:            overrides.env         || process.env.TARGET_ENV  || null
    };
  }

  /** @private */
  _parseList(val) {
    if (!val) return [];
    if (Array.isArray(val)) return val;
    return val.split(',').map(v => v.trim()).filter(Boolean);
  }

  /** @private */
  _parseNum(val) {
    if (val === undefined || val === null || val === '') return null;
    const n = parseInt(val, 10);
    return isNaN(n) ? null : n;
  }

  /** @private — Load scenario IDs from a named suite file */
  _loadSuite(suiteName) {
    const suitePath = path.join(__dirname, '../suites', `${suiteName}.json`);
    if (!fs.existsSync(suitePath)) {
      throw new Error(`[Filter] Suite file not found: ${suitePath}`);
    }
    const suite = JSON.parse(fs.readFileSync(suitePath, 'utf-8'));
    return suite.scenarios || [];
  }

  /** @private — Load failed scenario IDs from most recent report */
  _loadFailedScenarioIds() {
    const reportsDir = path.join(__dirname, '../reports');
    if (!fs.existsSync(reportsDir)) return [];

    const reports = fs.readdirSync(reportsDir)
      .filter(f => f.endsWith('.json'))
      .sort()
      .reverse();

    if (reports.length === 0) return [];

    const lastReport = JSON.parse(
      fs.readFileSync(path.join(reportsDir, reports[0]), 'utf-8')
    );

    return (lastReport.scenarios || [])
      .filter(s => s.status === 'FAILED')
      .map(s => s.id);
  }
}

module.exports = new ScenarioFilter();
