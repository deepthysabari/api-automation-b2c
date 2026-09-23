module.exports = {
  testEnvironment: 'node',
  verbose: true,
  testTimeout: 30000,
  // Caps how many test.concurrent scenarios run in flight at once (tests/scenarios.test.js).
  // Matches the CONCURRENCY bound used by cli/run.js and the UI's /api/run — the live API
  // throttles auth (Signature Code 800) under too much concurrent load.
  //
  // Lowered from 3 to 2 (2026-09-23): as the suite has grown (39 -> 43 scenarios), the same
  // symptom kept recurring under concurrent load — searches returning severely truncated
  // results (e.g. 1 carrier instead of the usual several) or exhausting the poll budget before
  // Completed ever flipped True, neither reproducible in a serial/standalone check on the same
  // route/date. Bumping the poll budget (30 -> 40, same date) only bought temporary headroom and
  // would need bumping again at the next scenario-count milestone — the actual lever is shared
  // backend contention, not poll patience. Lower concurrency directly reduces that contention
  // instead of compensating for its symptom indefinitely.
  maxConcurrency: parseInt(process.env.CONCURRENCY, 10) || 2,
  reporters: [
    'default'
  ]
};
