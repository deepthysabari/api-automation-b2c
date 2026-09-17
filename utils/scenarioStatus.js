'use strict';

/**
 * classifyScenarioStatus — the single source of truth for turning a raw scenarioResult
 * (status: PASSED/FAILED/SKIPPED, from engine/runner.js) into the 4-way display status the UI
 * and reports actually use: 'pass' | 'fail' | 'skip' | 'warn'.
 *
 * 'warn' is NOT a raw runner status — engine/runner.js only ever sets PASSED/FAILED/SKIPPED.
 * A scenario "warns" when it completed with no errors but at least one step recorded a
 * validator warning (e.g. an optional/limited-availability carrier check, a shallow fare-rule
 * Info[] block). Two callers need this exact same classification and must never drift apart:
 * server/index.js's live UI view (mapScenarioForResponse) and utils/excelReportBuilder.js's
 * downloadable report. This used to live only in mapScenarioForResponse, which the Excel
 * export never replicated — so a warned scenario showed as plain PASSED in the spreadsheet.
 * Fixed by extracting this ONE function both now call.
 *
 * @param {Object} s - a raw scenarioResult (must have `.status` and `.steps[]`)
 * @returns {'pass'|'fail'|'skip'|'warn'}
 */
function classifyScenarioStatus(s) {
  const stepErrors = (s.steps || []).flatMap(step => step.errors || []);
  const stepWarnings = (s.steps || []).flatMap(step => step.warnings || []);

  if (s.status === 'SKIPPED') return 'skip';
  if (s.status === 'FAILED' || stepErrors.length > 0) return 'fail';
  if (stepWarnings.length > 0) return 'warn';
  return 'pass';
}

module.exports = { classifyScenarioStatus };
