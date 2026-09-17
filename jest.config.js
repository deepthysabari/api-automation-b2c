module.exports = {
  testEnvironment: 'node',
  verbose: true,
  testTimeout: 30000,
  // Caps how many test.concurrent scenarios run in flight at once (tests/scenarios.test.js).
  // Matches the CONCURRENCY bound used by cli/run.js and the UI's /api/run — the live API
  // throttles auth (Signature Code 800) under too much concurrent load.
  maxConcurrency: parseInt(process.env.CONCURRENCY, 10) || 3,
  reporters: [
    'default'
  ]
};
