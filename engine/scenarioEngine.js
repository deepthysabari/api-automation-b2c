'use strict';

const scenarioRegistry = require('../scenarios/registry');
const scenarioFilter   = require('../scenarios/filter');
const scenarioGenerator = require('../scenarios/generator');
const runner           = require('./runner');
const reportBuilder    = require('../utils/reportBuilder');
const logger           = require('../utils/logger');
const { runWithConcurrency } = require('../utils/concurrency');

/**
 * ScenarioEngine — Top-level orchestrator for the automation platform.
 *
 * Responsibilities:
 *   1. Load all scenario definitions (via registry)
 *   2. Apply dynamic filters (tags, suite, airline, etc.)
 *   3. Generate executable test cases (via generator + airline adapters)
 *   4. Execute scenarios sequentially (parallel support is via Jest projects)
 *   5. Finalize the run report
 *
 * Used by: tests/scenarios.test.js (Jest) and cli/run.js (direct execution)
 */
class ScenarioEngine {
  /**
   * Load and filter scenarios based on current environment/options.
   * @param {Object} [filterOptions] - Override filter options (for CLI)
   * @returns {Object[]} Array of executable test cases
   */
  load(filterOptions = {}) {
    logger.info('═══════════════════════════════════════════════');
    logger.info('  ✈  Airline API Automation Platform  ✈');
    logger.info('═══════════════════════════════════════════════');

    // 1. Initialize & load dynamic matrix generator (Startup Validation fail-fast)
    const matrixGenerator = require('../scenarios/matrixGenerator');
    matrixGenerator.init();

    // 2. Load all static scenario definitions
    const staticScenarios = scenarioRegistry.loadAll().getAll();
    logger.info(`[Engine] ${staticScenarios.length} static scenario definitions loaded`);

    // 3. Resolve execution profile for dynamic matrix generation
    const profile = filterOptions.profile || process.env.PROFILE || 'smoke';
    logger.info(`[Engine] Generating dynamic execution matrix for profile: "${profile}"`);

    const { scenarios: dynamicScenarios, summary: matrixSummary } = matrixGenerator.generate(profile);
    
    // Log generation summary
    logger.info(`[Engine] Matrix Generator Summary:
      * Valid Scenarios Generated : ${matrixSummary.totalValidGenerated}
      * Evaluated Combinations    : ${matrixSummary.totalCombinationsEvaluated}
      * Skipped (Multicity)        : ${matrixSummary.skippedMC}
      * Skipped (Infants)          : ${matrixSummary.skippedInfant}
      * Skipped (SSRs)             : ${matrixSummary.skippedSSR}
      * Skipped (Fare Families)    : ${matrixSummary.skippedFareFamily}
      * Skipped (LCC Business)     : ${matrixSummary.skippedLccBusiness}
      * Skipped (Int. Multicity)   : ${matrixSummary.skippedInternationalMC}
      * Skipped (Explosion Control): ${matrixSummary.skippedByExplosion}`);

    // Merge static and dynamic scenarios
    const allScenarios = [...staticScenarios, ...dynamicScenarios];

    // Store summary on reportBuilder for reporting integration
    const reportBuilder = require('../utils/reportBuilder');
    if (typeof reportBuilder.setMatrixSummary === 'function') {
      reportBuilder.setMatrixSummary(matrixSummary);
    } else {
      reportBuilder.matrixSummary = matrixSummary;
    }

    // 4. Apply filters
    const filtered = scenarioFilter.apply(allScenarios, filterOptions);
    if (filtered.length === 0) return [];

    // 5. Build executable test cases
    const testCases = scenarioGenerator.buildAll(filtered);
    logger.info(`[Engine] ${testCases.length} test case(s) ready for execution`);

    return testCases;
  }

  /**
   * Execute a single test case.
   * @param {Object} testCase - Built by ScenarioGenerator
   * @returns {Object} ScenarioResult
   */
  async execute(testCase) {
    return runner.runTestCase(testCase);
  }

  /**
   * Execute all provided test cases, up to CONCURRENCY (env, default 2 — see
   * jest.config.js's own default for why) at once. Scenarios are independent (own
   * context, own TUIs), so overlapping them is safe; the bound exists because the
   * live API throttles auth, and truncates search results, under too much
   * concurrent load.
   * @param {Object[]} testCases
   * @returns {Object[]} All scenario results, in input order
   */
  async executeAll(testCases) {
    reportBuilder.init(testCases.map(t => t.id));

    const concurrency = Math.max(1, parseInt(process.env.CONCURRENCY, 10) || 2);
    const results = await runWithConcurrency(testCases, concurrency, async (testCase) => {
      try {
        return await runner.runTestCase(testCase);
      } catch (err) {
        return {
          id: testCase.id,
          name: testCase.name,
          status: 'FAILED',
          error: err.message
        };
      }
    });

    reportBuilder.finalize();
    return results;
  }

  /**
   * Print execution summary to console.
   * @param {Object[]} results
   */
  printSummary(results) {
    const passed = results.filter(r => r.status === 'PASSED').length;
    const failed = results.filter(r => r.status === 'FAILED').length;

    logger.info('');
    logger.info('══════════════════ EXECUTION SUMMARY ══════════════════');
    logger.info(`  Total   : ${results.length}`);
    logger.info(`  ✅ Passed: ${passed}`);
    logger.info(`  ❌ Failed: ${failed}`);
    logger.info('════════════════════════════════════════════════════════');

    if (failed > 0) {
      logger.info('Failed scenarios:');
      results.filter(r => r.status === 'FAILED').forEach(r => {
        logger.info(`  ✗ ${r.id} — ${r.name}`);
      });
    }
  }
}

module.exports = new ScenarioEngine();
