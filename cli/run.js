'use strict';

require('dotenv').config();

const minimist      = require('minimist');
const scenarioEngine = require('../engine/scenarioEngine');
const reportBuilder  = require('../utils/reportBuilder');
const logger         = require('../utils/logger');

/**
 * CLI Execution Controller
 *
 * Usage examples:
 *   node cli/run.js --suite smoke
 *   node cli/run.js --suite regression
 *   node cli/run.js --tags dom,oneway --airline 6E
 *   node cli/run.js --scenario DOM_OW_1ADT_6E
 *   node cli/run.js --rerun-failed
 *   node cli/run.js --priority 1
 *   node cli/run.js --sector-type INT
 *   node cli/run.js --trip-type RT
 *
 * All flags can also be set as environment variables:
 *   SUITE=smoke node cli/run.js
 *   TAGS=dom,oneway AIRLINE=6E node cli/run.js
 */
async function main() {
  const args = minimist(process.argv.slice(2), {
    string:  ['suite', 'tags', 'airline', 'scenario', 'trip-type', 'sector-type', 'env', 'profile'],
    number:  ['priority'],
    boolean: ['rerun-failed', 'help'],
    alias: {
      s: 'suite',
      t: 'tags',
      a: 'airline',
      p: 'profile',
      h: 'help'
    }
  });

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  // Build filter options from CLI args
  const filterOptions = {
    suite:       args.suite       || null,
    tags:        args.tags        || '',
    airline:     args.airline     || null,
    tripType:    args['trip-type']    || null,
    sectorType:  args['sector-type']  || null,
    priority:    args.priority    || null,
    scenarioIds: args.scenario    ? [args.scenario] : [],
    rerunFailed: args['rerun-failed'] || false,
    env:         args.env         || null,
    profile:     args.profile     || null
  };

  try {
    // 1. Load & filter scenarios
    const testCases = scenarioEngine.load(filterOptions);

    if (testCases.length === 0) {
      logger.warn('No scenarios matched. Exiting.');
      process.exit(0);
    }

    // 2. Initialize report
    reportBuilder.init(testCases.map(t => t.id));

    // 3. Execute all
    logger.info(`\n[CLI] Starting execution of ${testCases.length} scenario(s)...\n`);
    const results = await scenarioEngine.executeAll(testCases);

    // 4. Print summary
    scenarioEngine.printSummary(results);

    // 5. Exit code based on results
    const failed = results.filter(r => r.status === 'FAILED').length;
    process.exit(failed > 0 ? 1 : 0);

  } catch (err) {
    logger.error(`[CLI] Fatal error: ${err.message}`);
    if (process.env.DEBUG === 'true') console.error(err.stack);
    process.exit(1);
  }
}

function printHelp() {
  console.log(`
✈  Airline API Automation Platform — CLI Runner

Usage:
  node cli/run.js [options]

Options:
  --profile <name>       Execution Profile for dynamic matrix (smoke|regression|nightly|production)
  --suite <name>         Run a named suite (smoke|sanity|regression|critical)
  --tags "expression"    Filter by tags (e.g. "smoke,domestic|int,~6E")
  --airline <IATA>       Filter by airline code (e.g. 6E)
  --trip-type <type>     Filter by trip type (OW|RT|MC)
  --sector-type <type>   Filter by sector type (DOM|INT)
  --priority <n>         Run only scenarios with priority <= n
  --scenario <id>        Run a single specific scenario by ID
  --rerun-failed         Re-run scenarios that failed in the last report
  --env <name>           Filter by environment tag
  --help                 Show this help

Examples:
  node cli/run.js --profile smoke
  node cli/run.js --profile regression --tags "6E AND meal"
  node cli/run.js --suite smoke
  node cli/run.js --tags dom,oneway --airline 6E
  node cli/run.js --scenario DOM_OW_1ADT_6E
  node cli/run.js --rerun-failed
  node cli/run.js --priority 1

Environment Variables (alternative to flags):
  PROFILE, SUITE, TAGS, AIRLINE, TRIP_TYPE, SECTOR_TYPE, PRIORITY, SCENARIO_IDS, RERUN_FAILED
  `);
}

main();
