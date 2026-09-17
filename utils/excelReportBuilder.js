'use strict';

const ExcelJS = require('exceljs');
const airlineResolver = require('../engine/airlineResolver');
const { classifyScenarioStatus } = require('./scenarioStatus');

const DISPLAY_STATUS = { pass: 'PASSED', fail: 'FAILED', skip: 'SKIPPED', warn: 'WARNING' };

// A handful of carriers are only reachable via a GDS/NDC provider's airlines[] list (e.g. 1SN),
// with no standalone entry in configs/airlines.json's LCC bucket — airlineResolver.getAirline()
// falls back to the bare code for `.Name` in that case (see engine/airlineResolver.js's provider-
// derived branch). This is a display-only override for the report, not a registry change.
const DISPLAY_NAME_OVERRIDES = {
  MH: 'Malaysia Airlines',
  SK: 'SAS',
  LO: 'LOT Polish Airlines',
  SV: 'Saudia',
  CX: 'Cathay Pacific',
  UA: 'United Airlines'
};

function airlineName(code) {
  if (!code) return '';
  const upper = String(code).toUpperCase().trim();
  if (DISPLAY_NAME_OVERRIDES[upper]) return DISPLAY_NAME_OVERRIDES[upper];
  const airline = airlineResolver.getAirline(upper);
  return (airline && airline.Name) ? airline.Name : upper;
}

function stageOf(tags) {
  const stageTag = (tags || []).find(t => typeof t === 'string' && t.startsWith('stage:'));
  return stageTag ? stageTag.split(':')[1] : '';
}

function failReasonOf(steps, classifiedStatus) {
  const errors = (steps || []).flatMap(s => s.errors || []);
  if (errors[0]) return errors[0];
  if (classifiedStatus === 'warn') {
    const warnings = (steps || []).flatMap(s => s.warnings || []);
    return warnings[0] || '';
  }
  return '';
}

const STATUS_FILL = {
  PASSED:  { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC6EFCE' } }, // green
  FAILED:  { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFC7CE' } }, // red
  SKIPPED: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE7E6E6' } }, // gray
  WARNING: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFEB9C' } }  // amber
};
const STATUS_FONT = {
  PASSED:  { color: { argb: 'FF006100' } },
  FAILED:  { color: { argb: 'FF9C0006' } },
  SKIPPED: { color: { argb: 'FF666666' } },
  WARNING: { color: { argb: 'FF9C6500' } }
};

const DETAIL_HEADERS = [
  'Run ID', 'Test Case ID', 'Scenario Name', 'Stage', 'Provider/Airline Code',
  'Provider/Airline Name', 'Sector Type', 'Trip Type', 'Route', 'Passenger Mix',
  'Status', 'Duration', 'Priority', 'Failure/Skip Reason'
];

/**
 * Build a .xlsx workbook (as a Buffer) from a completed/in-progress run's scenario results.
 * @param {Object[]} scenarios - reportBuilder._scenarios (raw scenarioResult objects, each
 *   carrying the full `scenario` reference — this must be called BEFORE any serialization step
 *   that strips it, e.g. reportBuilder.finalize()'s disk-written JSON does not carry `priority`).
 * @param {string} runId
 * @returns {Promise<Buffer>}
 */
async function buildWorkbook(scenarios, runId) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'api-automation-node';
  workbook.created = new Date();

  // classifyScenarioStatus is the SAME function server/index.js's live UI view uses — a
  // scenario with no errors but at least one step warning is 'warn', not 'pass' (see
  // utils/scenarioStatus.js). Using anything else here would silently show a warned scenario
  // as a plain PASS, which is exactly the bug this module was fixed for.
  const classified = scenarios.map(s => classifyScenarioStatus(s));
  const passed  = classified.filter(c => c === 'pass').length;
  const failed  = classified.filter(c => c === 'fail').length;
  const skipped = classified.filter(c => c === 'skip').length;
  const warned  = classified.filter(c => c === 'warn').length;
  const total   = scenarios.length;

  // ── Summary sheet ──────────────────────────────────────────────────────────
  const summarySheet = workbook.addWorksheet('Summary');
  summarySheet.columns = [{ width: 28 }, { width: 16 }];

  summarySheet.addRow(['Test Execution Report']).font = { bold: true, size: 14 };
  summarySheet.addRow(['Run ID', runId]);
  summarySheet.addRow(['Generated', new Date().toLocaleString()]);
  summarySheet.addRow([]);

  const totalsHeaderRow = summarySheet.addRow(['Total', 'Passed', 'Failed', 'Skipped', 'Warned', 'Pass Rate']);
  totalsHeaderRow.font = { bold: true };
  const passRate = (passed + failed) > 0 ? ((passed / (passed + failed)) * 100).toFixed(1) + '%' : 'N/A';
  summarySheet.addRow([total, passed, failed, skipped, warned, passRate]);
  summarySheet.addRow([]);

  // Per-airline/provider breakdown
  const perAirline = {};
  scenarios.forEach((s, i) => {
    const code = (s.airline || s.scenario?.dimensions?.airline || 'N/A').toUpperCase().trim();
    if (!perAirline[code]) perAirline[code] = { code, name: airlineName(code), total: 0, passed: 0, failed: 0, skipped: 0, warned: 0 };
    perAirline[code].total++;
    const c = classified[i];
    if (c === 'pass') perAirline[code].passed++;
    else if (c === 'fail') perAirline[code].failed++;
    else if (c === 'skip') perAirline[code].skipped++;
    else if (c === 'warn') perAirline[code].warned++;
  });

  const breakdownHeaderRow = summarySheet.addRow(['Airline/Provider', 'Name', 'Total', 'Passed', 'Failed', 'Skipped', 'Warned']);
  breakdownHeaderRow.font = { bold: true };
  breakdownHeaderRow.eachCell(cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9D9D9' } };
  });
  summarySheet.getColumn(3).width = 10;
  summarySheet.getColumn(4).width = 10;
  summarySheet.getColumn(5).width = 10;
  summarySheet.getColumn(6).width = 10;
  summarySheet.getColumn(7).width = 10;

  Object.values(perAirline)
    .sort((a, b) => a.code.localeCompare(b.code))
    .forEach(row => {
      summarySheet.addRow([row.code, row.name, row.total, row.passed, row.failed, row.skipped, row.warned]);
    });

  // ── Test Cases sheet ────────────────────────────────────────────────────────
  const detailSheet = workbook.addWorksheet('Test Cases');
  detailSheet.columns = DETAIL_HEADERS.map(h => ({ header: h, key: h, width: 22 }));
  detailSheet.getColumn('Scenario Name').width = 55;
  detailSheet.getColumn('Failure/Skip Reason').width = 55;
  detailSheet.getColumn('Test Case ID').width = 45;

  const headerRow = detailSheet.getRow(1);
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.eachCell(cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };
  });
  detailSheet.views = [{ state: 'frozen', ySplit: 1 }];

  scenarios.forEach((s, i) => {
    const code = (s.airline || s.scenario?.dimensions?.airline || 'N/A').toUpperCase().trim();
    const displayStatus = DISPLAY_STATUS[classified[i]];
    const row = detailSheet.addRow({
      'Run ID': runId,
      'Test Case ID': s.id,
      'Scenario Name': s.name,
      'Stage': stageOf(s.tags),
      'Provider/Airline Code': code,
      'Provider/Airline Name': airlineName(code),
      'Sector Type': s.sectorType || '',
      'Trip Type': s.tripType || '',
      'Route': s.routeInfo || '',
      'Passenger Mix': s.passengerMix || '',
      'Status': displayStatus,
      'Duration': s.duration || '',
      'Priority': s.scenario?.priority ?? '',
      'Failure/Skip Reason': failReasonOf(s.steps, classified[i])
    });

    const statusCell = row.getCell('Status');
    const fill = STATUS_FILL[displayStatus];
    const font = STATUS_FONT[displayStatus];
    if (fill) statusCell.fill = fill;
    if (font) statusCell.font = { ...font, bold: true };
  });

  detailSheet.autoFilter = { from: 'A1', to: `${String.fromCharCode(64 + DETAIL_HEADERS.length)}1` };

  return workbook.xlsx.writeBuffer();
}

module.exports = { buildWorkbook, airlineName };
