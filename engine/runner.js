'use strict';

const executor        = require('./executor');
const validatorRegistry = require('../validators/registry');
const reportBuilder   = require('../utils/reportBuilder');
const logger          = require('../utils/logger');

/**
 * Runner — Scenario-aware step orchestrator.
 *
 * Enhanced from v1 to support:
 *   - Scenario metadata (airline, tripType, passengerMix) for reporting
 *   - Pluggable validation pipeline (no-throw, collects all errors)
 *   - Per-step timing
 *   - Structured result objects fed to reportBuilder
 *   - Retry support (configurable via testCase.retries)
 */
class Runner {
  /**
   * Run a fully built test case (produced by ScenarioGenerator), retrying a FAILED attempt
   * up to `testCase.retries` times (from the `@retries:N` tag — see scenarios/bddInterpreter.js
   * and scenarios/generator.js). Each attempt is a fresh run with a clean context (no state
   * carried over from a failed attempt); a SKIPPED result is never retried, since that is
   * already a legitimate business outcome (no live inventory, unsellable fare, ...), not
   * something a retry would fix — only a genuine FAILED attempt is worth retrying, to absorb
   * ordinary live-API flakiness (timeouts, transient auth throttling, a rare stuck session).
   * @param {Object} testCase - { id, name, scenario, steps, validators, retries }
   * @returns {Object} ScenarioResult (the LAST attempt's result — only that one is reported)
   */
  async runTestCase(testCase) {
    const meta = testCase._meta || {};
    const maxAttempts = 1 + Math.max(0, parseInt(testCase.retries, 10) || 0);

    this._wireDateRetry(testCase);

    let result;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) {
        logger.warn(`  [RETRY] Attempt ${attempt}/${maxAttempts} for "${testCase.name}" (previous attempt FAILED) — retrying with a fresh context...`);
      }
      result = await this._runAttempt(testCase, meta);
      if (result.status !== 'FAILED') break; // PASSED or SKIPPED — nothing a retry would improve
    }

    reportBuilder.record(result);

    if (result.status === 'PASSED') {
      logger.scenarioPass(testCase.name, result.duration);
    } else if (result.status === 'FAILED') {
      const allErrors = result.steps.flatMap(s => s.errors);
      logger.scenarioFail(testCase.name, allErrors);
      throw new Error(`Scenario FAILED: ${testCase.name}\n${allErrors.join('\n')}`);
    } else {
      // Skipped: not applicable to this route/carrier. Reported, but not a failure.
      logger.scenarioSkip(testCase.name, result.steps.flatMap(s => s.errors));
    }

    return result;
  }

  /**
   * Run ONE attempt of a test case's full step sequence and return its result — never throws,
   * never records to reportBuilder, never logs the scenario-level pass/fail/skip outcome (the
   * caller, runTestCase, owns all of that, since it may run this multiple times per retry).
   * @private
   */
  async _runAttempt(testCase, meta) {
    logger.scenarioStart(testCase.name, meta);

    const context = {};
    const stepResults = [];
    const runStart = Date.now();

    // Steps run strictly sequentially with fail-fast semantics, EXCEPT a domestic-multicity
    // search phase: those legs are independent cold searches, so they are dispatched
    // concurrently and fault-isolated (see _groupSteps).
    for (const group of this._groupSteps(testCase.steps)) {
      let halt = false;

      if (group.type === 'parallelLegs') {
        const resultsByStep = new Map();

        // One task per leg. Inside a leg the steps stay sequential (GetExpSearch needs that
        // leg's own ExpressSearch TUI); across legs there is no dependency whatsoever, so a
        // leg failing/skipping stops only itself.
        await Promise.all(group.legs.map(async legSteps => {
          for (const step of legSteps) {
            const result = await this._runStep(step, context, testCase);
            resultsByStep.set(step, result);
            if (result.status !== 'PASSED') break;
          }
        }));

        // Report in declared step order, not completion order.
        for (const step of group.order) {
          const result = resultsByStep.get(step);
          if (!result) continue;   // earlier step in the same leg failed; nothing was attempted
          if (result.status === 'FAILED') { logger.stepFail(step.name, result.errors); halt = true; }
          else if (result.status === 'SKIPPED') { logger.stepSkip(step.name, result.errors); halt = true; }
          else logger.stepPass(step.name, result.duration);
          stepResults.push(result);
        }
      } else {
        const step = group.step;
        const result = await this._runStep(step, context, testCase);
        if (result.status === 'FAILED') { logger.stepFail(step.name, result.errors); halt = true; }
        else if (result.status === 'SKIPPED') { logger.stepSkip(step.name, result.errors); halt = true; }
        else logger.stepPass(step.name, result.duration);
        stepResults.push(result);
      }

      // Nothing downstream of a failed/skipped step can run (the pricing/SSR/booking phase
      // depends on the search phase's saved fare context).
      if (halt) break;
    }

    const totalDuration = ((Date.now() - runStart) / 1000).toFixed(2) + 's';
    const anyFailed     = stepResults.some(s => s.status === 'FAILED');
    const anySkipped    = stepResults.some(s => s.status === 'SKIPPED');

    const scenarioResult = {
      id:          testCase.id,
      name:        testCase.name,
      tags:        testCase.tags,
      status:      anyFailed ? 'FAILED' : (anySkipped ? 'SKIPPED' : 'PASSED'),
      duration:    totalDuration,
      airline:     meta.airline,
      sectorType:  meta.sectorType,
      tripType:    meta.tripType,
      passengerMix:`${meta.passengerMix?.ADT || 0}ADT_${meta.passengerMix?.CHD || 0}CHD_${meta.passengerMix?.INF || 0}INF`,
      poolName:    meta.poolName,
      routeInfo:   meta.routeInfo,
      routeCategory: meta.routeCategory,
      transactionId: context.TransactionID || null,
      steps:       stepResults,
      scenario:    testCase.scenario
    };

    return scenarioResult;
  }

  // Date-retry budget for the opt-in `retryDatesOnEmptyInventory` dimension: 2 extra
  // attempts, each measured from the ORIGINAL date (+2 then +4 days).
  DATE_RETRY_EXTRA_ATTEMPTS = 2;
  DATE_RETRY_DAY_STEP = 2;

  /**
   * Opt-in only: pair each getSearch step with the ExpressSearch step that produced its TUI,
   * so the executor can re-issue the identical search on a later date when the search
   * completes with zero journeys.
   *
   * This exists for low-frequency carriers whose real-world schedule does not fly daily (e.g.
   * Star Air's NDC channel on HYD-PNQ: zero inventory one day, two journeys two days later) —
   * there, an empty search on a single date proves nothing about the carrier/route. Wiring
   * happens ONLY when the scenario declares `dimensions.retryDatesOnEmptyInventory`; without
   * it no `_dateRetry` is attached and the executor's behaviour is unchanged, keeping every
   * other scenario strictly date-deterministic.
   * @private
   */
  _wireDateRetry(testCase) {
    if (testCase.scenario?.dimensions?.retryDatesOnEmptyInventory !== true) return;

    const steps = testCase.steps || [];
    steps.forEach((step, i) => {
      if (step._stepKey !== 'getSearch') return;
      // The matching search step is the nearest preceding 'search' step of the same leg
      // (domestic multicity has one pair per leg; every other flow has exactly one pair).
      let searchStep = null;
      for (let j = i - 1; j >= 0; j--) {
        if (steps[j]._stepKey === 'search' && steps[j]._legIndex === step._legIndex) {
          searchStep = steps[j];
          break;
        }
      }
      if (!searchStep) return;

      step._dateRetry = {
        searchStep,
        extraAttempts: this.DATE_RETRY_EXTRA_ATTEMPTS,
        dayStep: this.DATE_RETRY_DAY_STEP
      };
    });
  }

  /**
   * Partition a flat step array into execution groups.
   *
   * Every step is its own serial group — the default, unchanged, fail-fast behaviour — except
   * a consecutive run of steps that carry a `_legIndex` AND are search-phase steps
   * (`_stepKey` 'search' / 'getSearch'). Only the domestic-multicity flows emit those, and
   * those legs are genuinely independent one-way searches: each sends `TUI:""`, mints its own
   * TUI, saves to its own `SearchTUI_${i}`/`Amount_${i}`/... keys and validates on its own
   * `Trips[0]`. Such a run becomes one `parallelLegs` group so the legs dispatch concurrently
   * and a failing leg does not suppress its siblings.
   *
   * A run with a single leg degenerates to serial steps, so no other flow changes shape.
   *
   * @returns {Array<{type:'serial',step:Object}|{type:'parallelLegs',legs:Object[][],order:Object[]}>}
   */
  _groupSteps(steps) {
    const isParallelSearchStep = s =>
      !!s && s._legIndex !== undefined && (s._stepKey === 'search' || s._stepKey === 'getSearch');

    const groups = [];
    let i = 0;

    while (i < steps.length) {
      if (!isParallelSearchStep(steps[i])) {
        groups.push({ type: 'serial', step: steps[i] });
        i++;
        continue;
      }

      const run = [];
      while (i < steps.length && isParallelSearchStep(steps[i])) { run.push(steps[i]); i++; }

      const byLeg = new Map();
      for (const s of run) {
        if (!byLeg.has(s._legIndex)) byLeg.set(s._legIndex, []);
        byLeg.get(s._legIndex).push(s);
      }

      if (byLeg.size > 1) {
        groups.push({ type: 'parallelLegs', legs: [...byLeg.values()], order: run });
      } else {
        run.forEach(s => groups.push({ type: 'serial', step: s }));
      }
    }

    return groups;
  }

  /**
   * Execute one step and run its validator pipeline. Never throws — the outcome is the
   * returned result's `status` (PASSED / FAILED / SKIPPED).
   */
  async _runStep(step, context, testCase) {
    const stepStart = Date.now();
    logger.stepStart(step.name);

    let stepResult = {
      name:       step.name,
      status:     'PASSED',
      duration:   0,
      errors:     [],
      warnings:   [],
      validations: {},
      validatorResults: []
    };

    try {
      // ── Execute the step
      const response = await executor.execute(step, context);

      if (response) {
        let reqBody = response.config?.data;
        if (typeof reqBody === 'string') {
          try { reqBody = JSON.parse(reqBody); } catch (_) {}
        }
        stepResult.request = {
          url: response.config?.url || (step.request?.url || ''),
          method: response.config?.method?.toUpperCase() || (step.request?.method?.toUpperCase() || 'POST'),
          headers: response.config?.headers || null,
          body: reqBody || null
        };
        stepResult.response = {
          status: response.status || 200,
          statusText: response.statusText || 'OK',
          headers: response.headers || null,
          body: response.data || null
        };
      }

      // ── Run the validation pipeline
      const validatorNames = [
        ...(step._validators || []),
        ...(testCase.validators || [])
      ];
      const uniqueValidators = [...new Set(validatorNames)];

      for (const vName of uniqueValidators) {
        let validator;
        try { validator = validatorRegistry.resolve(vName); }
        catch (e) { logger.warn(e.message); continue; }

        const result = validator.validate(response, context, testCase.scenario, step);

        stepResult.validations[vName] = result.passed ? 'PASSED' : 'FAILED';

        let vStatus = 'pass';
        let vMsg = '';

        if (!result.passed) {
          stepResult.status = 'FAILED';
          stepResult.errors.push(...result.errors);
          vStatus = 'fail';
          vMsg = result.errors.join('; ');
        } else if (result.warnings && result.warnings.length > 0) {
          stepResult.warnings.push(...result.warnings);
          result.warnings.forEach(w => logger.warn(`  [WARN][${vName}] ${w}`));
          vStatus = 'warn';
          vMsg = result.warnings.join('; ');
        } else {
          // Success messages with contextual diagnostic details
          if (vName === 'business') {
            const code = response?.data?.Code || 200;
            const msg = Array.isArray(response?.data?.Msg) ? response.data.Msg.join(', ') : (response?.data?.Msg || 'Success');
            vMsg = `Code ${code}, Msg: ${msg}`;
          } else if (vName === 'segment') {
            const origin = testCase.scenario?.dataset?.origin || testCase.scenario?.dimensions?.origin || 'N/A';
            const dest = testCase.scenario?.dataset?.destination || testCase.scenario?.dimensions?.destination || 'N/A';
            vMsg = `Origin/destination match confirmed: ${origin}→${dest}`;
          } else if (vName === 'availability') {
            const numTrips = Array.isArray(response?.data?.Trips) ? response.data.Trips.length : 0;
            vMsg = `Flight availability verified (found ${numTrips} trip options)`;
          } else if (vName === 'pricing') {
            if (step._stepKey === 'getPrice') {
              vMsg = `Fare amount validated: priced NetAmount ${response?.data?.NetAmount || 'N/A'}`;
            } else {
              vMsg = 'Fare amount validation passed: net and gross fares are positive';
            }
          } else if (vName === 'passenger') {
            const mix = testCase.scenario?.dimensions?.passengerMix || {};
            vMsg = `Passenger mix validation confirmed: ${mix.ADT || 0} ADT, ${mix.CHD || 0} CHD, ${mix.INF || 0} INF`;
          } else if (vName === 'cabinClass') {
            const expectedCabin = (testCase.scenario?.dimensions?.expectedCabin || testCase.scenario?.dimensions?.cabinClass || 'E').toUpperCase();
            vMsg = `Cabin class confirmed: all segments match requested class ${expectedCabin}`;
          } else if (vName === 'directFlight') {
            vMsg = 'Direct flight check: journey has exactly 1 segment';
          } else if (vName === 'nearbyAirport') {
            const origin = testCase.scenario?.dataset?.origin || testCase.scenario?.dimensions?.origin || 'N/A';
            const dest = testCase.scenario?.dataset?.destination || testCase.scenario?.dimensions?.destination || 'N/A';
            vMsg = `Nearby airport mapping validated: origin/destination match expected values (${origin}/${dest})`;
          } else if (vName === 'roundtrip') {
            vMsg = 'Round trip routing verified: outbound destination matches inbound origin';
          } else if (vName === 'multicity') {
            vMsg = 'Multi-city segment connectivity validated';
          } else if (vName === 'airlineLeakage') {
            const expectedAirlineStr = testCase.scenario?.dimensions?.airline || 'N/A';
            vMsg = `Airline leakage verification passed: only expected carriers (${expectedAirlineStr}) present`;
          } else if (result.message) {
            vMsg = result.message;
          } else {
            vMsg = `${vName} verification passed successfully`;
          }
        }

        stepResult.validatorResults.push({
          name: vName,
          result: vStatus,
          message: vMsg
        });
      }

    } catch (err) {
      // A step may declare the scenario inapplicable rather than broken — e.g. a premium
      // cabin on a route the carrier does not sell it on. That is not a failure, and must
      // not be reported as one.
      stepResult.status = /^SKIPPED:/.test(err.message || '') ? 'SKIPPED' : 'FAILED';
      stepResult.errors.push(err.message);

      const reqConfig = err.config || err.response?.config;
      if (reqConfig) {
        let reqBody = reqConfig.data;
        if (typeof reqBody === 'string') {
          try { reqBody = JSON.parse(reqBody); } catch (_) {}
        }
        stepResult.request = {
          url: reqConfig.url || (step.request?.url || ''),
          method: reqConfig.method?.toUpperCase() || (step.request?.method?.toUpperCase() || 'POST'),
          headers: reqConfig.headers || null,
          body: reqBody || null
        };
      } else {
        stepResult.request = {
          url: step.request?.url || '',
          method: step.request?.method?.toUpperCase() || 'POST',
          headers: step.request?.headers || null,
          body: step.request?.body || step.request?.payload || null
        };
      }

      if (err.response) {
        stepResult.response = {
          status: err.response.status || 500,
          statusText: err.response.statusText || 'Error',
          headers: err.response.headers || null,
          body: err.response.data || null
        };
      } else {
        stepResult.response = {
          status: 0,
          statusText: 'No Response',
          headers: null,
          body: null
        };
      }
    }

    stepResult.duration = ((Date.now() - stepStart) / 1000).toFixed(2) + 's';
    return stepResult;
  }
}

module.exports = new Runner();
