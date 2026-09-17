'use strict';

require('dotenv').config();

const scenarioEngine = require('../engine/scenarioEngine');
const reportBuilder  = require('../utils/reportBuilder');

/**
 * Scenario-driven Jest test runner.
 *
 * Dynamically creates Jest test cases from scenario definitions,
 * respecting all active filter env vars (SUITE, TAGS, AIRLINE, etc.)
 *
 * Usage:
 *   npm run test:scenarios           → runs all scenarios
 *   SUITE=smoke npm run test:scenarios
 *   TAGS=dom,oneway npm run test:scenarios
 *   AIRLINE=6E npm run test:scenarios
 */

// Load and filter scenarios ONCE before all tests
const testCases = scenarioEngine.load();

beforeAll(() => {
  if (testCases.length > 0) {
    reportBuilder.init(testCases.map(t => t.id));
  }
});

afterAll(() => {
  reportBuilder.finalize();
});

describe('✈  Airline API Automation Platform', () => {

  if (testCases.length === 0) {
    test('No scenarios matched active filters', () => {
      console.warn('No scenarios matched. Check SUITE/TAGS/AIRLINE env vars.');
    });
    return;
  }

  // Group scenarios by airline + sectorType for a structured Jest report
  const groups = {};
  testCases.forEach(tc => {
    const key = `${tc._meta.airline} | ${tc._meta.sectorType}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(tc);
  });

  Object.entries(groups).forEach(([groupName, groupCases]) => {
    describe(groupName, () => {
      groupCases.forEach(testCase => {
        // test.concurrent: scenarios are independent (own context, own TUIs), so running
        // them overlapped (bounded by jest.config.js's maxConcurrency) cuts wall-clock time
        // for the suite instead of the strictly serial default. See utils/concurrency.js /
        // scenarioEngine.executeAll for the same bound applied to cli/run.js and the UI.
        test.concurrent(
          `[${testCase._meta.tripType}] ${testCase.name}`,
          async () => {
            await scenarioEngine.execute(testCase);
          },
          // 240s per scenario. CreateItinerary alone can now take up to 120s (see
          // Executor.CREATE_ITINERARY_TIMEOUT_MS — IX domestic oneway observed taking 87s live),
          // plus search/pricing/SSR/fare-rule steps ahead of it; 90s was too tight once that step
          // needed a longer per-request budget than apiClient's 60s default.
          240000
        );
      });
    });
  });

});
