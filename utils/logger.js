'use strict';

/**
 * Logger — Structured, color-coded console logger for the scenario engine.
 *
 * Provides semantic logging methods (stepStart, stepPass, scenarioFail, etc.)
 * instead of raw console.log() calls scattered throughout the code.
 */

// ANSI color codes (works in most terminals and CI systems)
const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  green:  '\x1b[32m',
  red:    '\x1b[31m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  blue:   '\x1b[34m',
  white:  '\x1b[37m',
  gray:   '\x1b[90m'
};

const ts = () => new Date().toISOString().replace('T', ' ').substring(0, 19);

const logger = {
  info(msg) {
    console.log(`${C.gray}[${ts()}]${C.reset} ${C.white}${msg}${C.reset}`);
  },

  warn(msg) {
    console.warn(`${C.gray}[${ts()}]${C.reset} ${C.yellow}⚠  ${msg}${C.reset}`);
  },

  error(msg) {
    console.error(`${C.gray}[${ts()}]${C.reset} ${C.red}✖  ${msg}${C.reset}`);
  },

  scenarioStart(name, meta) {
    const pax = meta.passengerMix
      ? `${meta.passengerMix.ADT}ADT/${meta.passengerMix.CHD}CHD/${meta.passengerMix.INF}INF`
      : '';
    console.log('');
    console.log(`${C.bold}${C.cyan}${'─'.repeat(60)}${C.reset}`);
    console.log(`${C.bold}${C.cyan}  ✈  ${name}${C.reset}`);
    console.log(`${C.gray}     ${meta.airline || ''} | ${meta.sectorType || ''} | ${meta.tripType || ''} | ${pax}${C.reset}`);
    if (meta.routeInfo) {
      console.log(`${C.gray}     Route: ${meta.routeInfo} (Pool: ${meta.poolName}, Category: ${meta.routeCategory})${C.reset}`);
    }
    console.log(`${C.bold}${C.cyan}${'─'.repeat(60)}${C.reset}`);
  },

  scenarioPass(name, duration) {
    console.log(`${C.bold}${C.green}  ✅ PASSED${C.reset}${C.gray} [${duration}]${C.reset}  ${name}`);
  },

  scenarioFail(name, errors) {
    console.log(`${C.bold}${C.red}  ❌ FAILED${C.reset}  ${name}`);
    errors.forEach(e => console.log(`${C.red}     ↳ ${e}${C.reset}`));
  },

  stepStart(stepName) {
    console.log(`${C.gray}  → ${stepName}${C.reset}`);
  },

  stepPass(stepName, duration) {
    console.log(`${C.green}    ✓ ${stepName}${C.reset}${C.gray} (${duration})${C.reset}`);
  },

  stepFail(stepName, errors) {
    console.log(`${C.red}    ✗ ${stepName}${C.reset}`);
    errors.forEach(e => console.log(`${C.red}      ↳ ${e}${C.reset}`));
  },

  stepSkip(stepName, reasons = []) {
    console.log(`${C.yellow}    ⊘ ${stepName}${C.reset}`);
    reasons.forEach(r => console.log(`${C.yellow}      ↳ ${r}${C.reset}`));
  },

  scenarioSkip(name, reasons = []) {
    console.log(`${C.bold}${C.yellow}  ⊘ SKIPPED${C.reset}  ${name}`);
    reasons.forEach(r => console.log(`${C.yellow}     ↳ ${r}${C.reset}`));
  }
};

module.exports = logger;
