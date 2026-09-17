'use strict';

const fs   = require('fs');
const path = require('path');

/**
 * ReportBuilder — Builds a structured JSON report for each automation run.
 *
 * Each run produces: reports/RUN_<YYYYMMDD_HHmmss>.json
 *
 * Report structure:
 * {
 *   runId, startTime, endTime, duration,
 *   suite, totalScenarios, passed, failed,
 *   scenarios: [ { id, name, airline, tripType, status, duration, steps, validations } ]
 * }
 */
class ReportBuilder {
  constructor() {
    this._runId    = null;
    this._start    = null;
    this._scenarios = [];
    this._reportsDir = path.join(__dirname, '../reports');
    this._matrixSummary = null;
  }

  /**
   * Set dynamic matrix generation summary.
   * @param {Object} summary
   */
  setMatrixSummary(summary) {
    this._matrixSummary = summary;
  }

  /**
   * Initialize a new run report.
   * @param {string[]} scenarioIds - IDs of all scenarios in this run
   */
  init(scenarioIds = []) {
    const now = new Date();
    this._runId    = `RUN_${now.toISOString().replace(/[-:.TZ]/g, '').substring(0, 15)}`;
    this._start    = now;
    this._scenarios = [];
    this._total    = scenarioIds.length;

    if (!fs.existsSync(this._reportsDir)) {
      fs.mkdirSync(this._reportsDir, { recursive: true });
    }
  }

  /**
   * Record the result of a single scenario.
   * @param {Object} scenarioResult
   */
  record(scenarioResult) {
    if (!this._runId) this.init();
    this._scenarios.push(scenarioResult);
  }

  /**
   * Finalize the report and write to disk.
   * @returns {string} Path to the written report file
   */
  finalize() {
    if (!this._runId) return null;

    const end = new Date();
    const passed  = this._scenarios.filter(s => s.status === 'PASSED').length;
    const failed  = this._scenarios.filter(s => s.status === 'FAILED').length;
    const skipped = this._scenarios.filter(s => s.status === 'SKIPPED').length;

    // Calculate airline coverage and search mode metrics
    const airlineCoverageMetrics = {};
    let activeAirlines = ['6E', 'AI', 'SG', 'UK'];
    try {
      const airlineRegistry = require('../airlines/registry');
      const registered = airlineRegistry.getRegisteredAirlines();
      if (registered && registered.length > 0) {
        activeAirlines = registered;
      }
    } catch (err) {
      console.warn(`[ReportBuilder] Failed to load registered airlines dynamically, falling back to defaults: ${err.message}`);
    }
    
    activeAirlines.forEach(code => {
      airlineCoverageMetrics[code] = {
        runs: 0,
        passed: 0,
        failed: 0,
        passRate: '0%'
      };
    });

    let totalMarketplace = 0;
    let totalPreferred = 0;

    this._scenarios.forEach(s => {
      const sAirline = (s.airline || s.scenario?.dimensions?.airline || 'N/A').toUpperCase().trim();
      const sMode = s.scenario?.dimensions?.searchMode || 'marketplace';

      if (sMode === 'preferred') {
        totalPreferred++;
      } else {
        totalMarketplace++;
      }

      if (sAirline !== 'N/A') {
        if (!airlineCoverageMetrics[sAirline]) {
          airlineCoverageMetrics[sAirline] = {
            runs: 0,
            passed: 0,
            failed: 0,
            passRate: '0%'
          };
        }
        airlineCoverageMetrics[sAirline].runs++;
        if (s.status === 'PASSED') {
          airlineCoverageMetrics[sAirline].passed++;
        } else {
          airlineCoverageMetrics[sAirline].failed++;
        }
      }
    });

    // Compute rates
    Object.keys(airlineCoverageMetrics).forEach(code => {
      const metrics = airlineCoverageMetrics[code];
      if (metrics.runs > 0) {
        metrics.passRate = ((metrics.passed / metrics.runs) * 100).toFixed(1) + '%';
      }
    });

    airlineCoverageMetrics.summary = {
      totalMarketplace,
      totalPreferred,
      totalAirlinesTested: Object.keys(airlineCoverageMetrics).filter(k => k !== 'summary' && airlineCoverageMetrics[k].runs > 0).length
    };

    const report = {
      runId:          this._runId,
      startTime:      this._start.toISOString(),
      endTime:        end.toISOString(),
      duration:       ((end - this._start) / 1000).toFixed(2) + 's',
      suite:          process.env.SUITE || 'custom',
      environment:    process.env.TARGET_ENV || process.env.ENV || 'beta',
      matrixSummary:  this._matrixSummary,
      airlineCoverageMetrics,
      totalScenarios: this._scenarios.length,
      passed,
      failed,
      skipped,
      // Skipped scenarios are not applicable to the route/carrier, so they are excluded from
      // the denominator rather than counted as failures.
      passRate:       (passed + failed) > 0
        ? ((passed / (passed + failed)) * 100).toFixed(1) + '%'
        : '0%',
      scenarios: this._scenarios.map(s => ({
        id:          s.id,
        name:        s.name,
        tags:        s.tags || [],
        airline:     s.airline || s.scenario?.dimensions?.airline || 'N/A',
        searchMode:  s.scenario?.dimensions?.searchMode || 'marketplace',
        sectorType:  s.sectorType,
        tripType:    s.tripType,
        passengerMix:s.passengerMix,
        poolName:    s.poolName || 'hardcoded',
        routeInfo:   s.routeInfo || 'N/A',
        routeCategory: s.routeCategory || 'N/A',
        status:      s.status,
        duration:    s.duration,
        transactionId: s.transactionId || null,
        // Itinerary changes accepted between search and pricing (fare / schedule / airport / etc.),
        // rolled up from the step warnings tagged "CHANGE:" so they surface prominently.
        changesDetected: (s.steps || []).flatMap(step =>
          (step.warnings || []).filter(w => /^CHANGE:/i.test(w)).map(w => w.replace(/^CHANGE:\s*/i, ''))
        ),
        steps: (s.steps || []).map(step => ({
          name:        step.name,
          status:      step.status,
          duration:    step.duration,
          validations: step.validations || {},
          errors:      step.errors || [],
          warnings:    step.warnings || [],
          request:     step.request || null,
          response:    step.response || null
        }))
      }))
    };

    const outPath = path.join(this._reportsDir, `${this._runId}.json`);
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf-8');
    console.log(`\n[Report] 📄 Saved JSON: ${outPath}`);

    // Generate and write HTML dashboard report
    try {
      const htmlContent = this._generateHtmlDashboard(report);
      const htmlPath = path.join(this._reportsDir, `${this._runId}.html`);
      const latestHtmlPath = path.join(this._reportsDir, 'latest_report.html');
      
      fs.writeFileSync(htmlPath, htmlContent, 'utf-8');
      fs.writeFileSync(latestHtmlPath, htmlContent, 'utf-8');
      console.log(`[Report] 📊 Saved HTML Dashboard: ${htmlPath}`);
      console.log(`[Report] 🔗 Updated Latest Report: ${latestHtmlPath}`);
    } catch (htmlErr) {
      console.error(`[Report] ❌ Failed to generate HTML Dashboard: ${htmlErr.message}`);
    }

    this._cleanupOldReports(10);

    return outPath;
  }

  /**
   * Cleans up old reports, keeping only the most recent N runs.
   * @param {number} keepCount - Number of recent runs to keep
   * @private
   */
  _cleanupOldReports(keepCount = 10) {
    try {
      if (!fs.existsSync(this._reportsDir)) return;

      const files = fs.readdirSync(this._reportsDir);
      
      // Filter JSON files of runs (starts with RUN_ and ends with .json)
      const jsonFiles = files
        .filter(f => f.startsWith('RUN_') && f.endsWith('.json'))
        .map(f => {
          const filePath = path.join(this._reportsDir, f);
          const stats = fs.statSync(filePath);
          return {
            name: f,
            jsonPath: filePath,
            htmlPath: path.join(this._reportsDir, f.replace('.json', '.html')),
            mtime: stats.mtimeMs
          };
        });

      // Sort by modified time descending (newest first)
      jsonFiles.sort((a, b) => b.mtime - a.mtime);

      if (jsonFiles.length <= keepCount) {
        return; // Nothing to cleanup
      }

      // Files to delete
      const toDelete = jsonFiles.slice(keepCount);
      console.log(`\n[Report Cleanup] Found ${jsonFiles.length} runs. Deleting ${toDelete.length} older runs (keeping latest ${keepCount})...`);

      toDelete.forEach(run => {
        try {
          if (fs.existsSync(run.jsonPath)) {
            fs.unlinkSync(run.jsonPath);
          }
          if (fs.existsSync(run.htmlPath)) {
            fs.unlinkSync(run.htmlPath);
          }
          console.log(`[Report Cleanup] Deleted: ${run.name.replace('.json', '')}`);
        } catch (err) {
          console.warn(`[Report Cleanup] Failed to delete file for ${run.name}: ${err.message}`);
        }
      });
    } catch (err) {
      console.error(`[Report Cleanup] Error during report cleanup: ${err.message}`);
    }
  }

  /**
   * Stringify a request/response payload for embedding in the HTML dashboard, capped to a
   * safe size. A single scenario's flight search can carry hundreds of journeys — embedding
   * every step's full raw body, uncapped, across 100+ scenarios has been observed to grow the
   * single in-memory HTML string past what fs.writeFileSync can reliably write on Windows
   * (a generic "UNKNOWN: unknown error, write" — not an OOM, raising the heap limit didn't
   * help). The full, untruncated payload is always in the sibling RUN_*.json report.
   * @private
   */
  _stringifyPayloadForHtml(payload) {
    const full = JSON.stringify(payload, null, 2);
    const MAX_CHARS = 20000;
    if (full.length <= MAX_CHARS) return full;
    return full.slice(0, MAX_CHARS) +
      `\n\n... [truncated ${full.length - MAX_CHARS} more characters — see the full payload in the matching RUN_*.json report] ...`;
  }

  /**
   * Generates a self-contained premium HTML dashboard string.
   * @private
   */
  _generateHtmlDashboard(report) {
    const totalScenarios = report.totalScenarios;
    const passed = report.passed;
    const failed = report.failed;
    const skipped = report.skipped || 0;
    const passRate = report.passRate;
    const duration = report.duration;
    const suite = report.suite;
    const env = report.environment;
    const runId = report.runId;
    const timestamp = new Date(report.startTime).toLocaleString();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Test Execution Report - ${runId}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-primary: #0b0f19;
      --bg-secondary: #161c2d;
      --bg-tertiary: #1f293d;
      --border-color: #2e3a52;
      --text-primary: #f3f4f6;
      --text-secondary: #9ca3af;
      --text-muted: #6b7280;
      
      --accent-color: #4f46e5;
      --accent-hover: #6366f1;
      
      --success-color: #10b981;
      --success-bg: rgba(16, 185, 129, 0.1);
      --success-border: rgba(16, 185, 129, 0.2);
      
      --fail-color: #ef4444;
      --fail-bg: rgba(239, 68, 68, 0.1);
      --fail-border: rgba(239, 68, 68, 0.2);
      
      --warning-color: #f59e0b;
      --warning-bg: rgba(245, 158, 11, 0.1);
      --warning-border: rgba(245, 158, 11, 0.2);
      
      --info-color: #3b82f6;
      --info-bg: rgba(59, 130, 246, 0.1);
      
      --glass-bg: rgba(22, 28, 45, 0.7);
      --glass-blur: blur(12px);
    }
    
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    
    body {
      font-family: 'Outfit', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background-color: var(--bg-primary);
      color: var(--text-primary);
      line-height: 1.5;
      padding-bottom: 80px;
    }
    
    header {
      background: linear-gradient(135deg, #1e1b4b 0%, #0b0f19 100%);
      border-bottom: 1px solid var(--border-color);
      padding: 30px 4%;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 20px;
    }
    
    .logo-area h1 {
      font-size: 2.2rem;
      font-weight: 800;
      letter-spacing: -0.025em;
      background: linear-gradient(to right, #818cf8, #c084fc, #f472b6);
      -webkit-background-clip: text;
      background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-bottom: 5px;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    
    .logo-area p {
      color: var(--text-secondary);
      font-size: 0.95rem;
    }
    
    .run-badge {
      background-color: var(--bg-tertiary);
      border: 1px solid var(--border-color);
      padding: 6px 14px;
      border-radius: 99px;
      font-size: 0.85rem;
      font-weight: 500;
      color: var(--text-secondary);
    }

    .main-container {
      max-width: 1400px;
      margin: 30px auto;
      padding: 0 4%;
    }
    
    /* Metrics Overview Dashboard */
    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 20px;
      margin-bottom: 40px;
    }
    
    .metric-card {
      background: var(--glass-bg);
      backdrop-filter: var(--glass-blur);
      border: 1px solid var(--border-color);
      border-radius: 16px;
      padding: 24px;
      position: relative;
      overflow: hidden;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
      transition: transform 0.2s ease, border-color 0.2s ease;
    }
    
    .metric-card:hover {
      transform: translateY(-2px);
      border-color: var(--accent-hover);
    }
    
    .metric-card::after {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      width: 4px;
      height: 100%;
    }
    
    .metric-card.total::after { background-color: var(--accent-color); }
    .metric-card.passed::after { background-color: var(--success-color); }
    .metric-card.failed::after { background-color: var(--fail-color); }
    .metric-card.rate::after { background-color: var(--warning-color); }
    
    .metric-label {
      font-size: 0.875rem;
      color: var(--text-secondary);
      text-transform: uppercase;
      font-weight: 600;
      letter-spacing: 0.05em;
      margin-bottom: 8px;
    }
    
    .metric-value {
      font-size: 2.25rem;
      font-weight: 800;
      line-height: 1;
    }
    
    .metric-meta {
      font-size: 0.825rem;
      color: var(--text-muted);
      margin-top: 10px;
      display: flex;
      justify-content: space-between;
    }
    
    /* Two Column Layout */
    .dashboard-layout {
      display: grid;
      grid-template-columns: 320px 1fr;
      gap: 30px;
      align-items: start;
    }
    
    @media (max-width: 992px) {
      .dashboard-layout {
        grid-template-columns: 1fr;
      }
    }
    
    /* Sidebar info */
    .sidebar {
      display: flex;
      flex-direction: column;
      gap: 30px;
    }
    
    .card {
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: 16px;
      padding: 24px;
      box-shadow: 0 4px 10px rgba(0, 0, 0, 0.1);
    }
    
    .card-title {
      font-size: 1.1rem;
      font-weight: 700;
      margin-bottom: 18px;
      border-bottom: 1px solid var(--border-color);
      padding-bottom: 10px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    
    .info-list {
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    
    .info-item {
      display: flex;
      justify-content: space-between;
      font-size: 0.9rem;
    }
    
    .info-key {
      color: var(--text-secondary);
    }
    
    .info-val {
      font-weight: 500;
    }
    
    /* Airline coverage custom table */
    .airline-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.875rem;
    }
    
    .airline-table th {
      text-align: left;
      color: var(--text-secondary);
      font-weight: 600;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--border-color);
    }
    
    .airline-table td {
      padding: 10px 0;
      border-bottom: 1px dashed rgba(46, 58, 82, 0.5);
    }
    
    .airline-table tr:last-child td {
      border-bottom: none;
    }
    
    .airline-badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      background-color: var(--bg-tertiary);
      font-weight: bold;
      color: #818cf8;
    }
    
    /* Main test details content */
    .results-area {
      display: flex;
      flex-direction: column;
      gap: 20px;
    }
    
    .filter-bar {
      display: flex;
      gap: 15px;
      align-items: center;
      flex-wrap: wrap;
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      padding: 15px 20px;
      border-radius: 12px;
    }
    
    .search-input {
      flex: 1;
      min-width: 250px;
      background: var(--bg-primary);
      border: 1px solid var(--border-color);
      color: var(--text-primary);
      padding: 10px 16px;
      border-radius: 8px;
      font-size: 0.9rem;
      outline: none;
      transition: border-color 0.2s;
    }
    
    .search-input:focus {
      border-color: var(--accent-hover);
    }
    
    .filter-buttons {
      display: flex;
      gap: 8px;
    }
    
    .filter-btn {
      background: var(--bg-tertiary);
      border: 1px solid var(--border-color);
      color: var(--text-secondary);
      padding: 8px 16px;
      border-radius: 8px;
      cursor: pointer;
      font-size: 0.85rem;
      font-weight: 500;
      transition: all 0.2s;
    }
    
    .filter-btn.active, .filter-btn:hover {
      background: var(--accent-color);
      color: #fff;
      border-color: var(--accent-color);
    }
    
    /* Scenario item lists styling */
    .scenario-card {
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.05);
      transition: border-color 0.2s;
    }
    
    .scenario-card:hover {
      border-color: rgba(99, 102, 241, 0.4);
    }
    
    .scenario-header {
      padding: 18px 24px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      cursor: pointer;
      user-select: none;
      background: rgba(30, 41, 59, 0.2);
    }
    
    .scenario-header-left {
      display: flex;
      align-items: center;
      gap: 15px;
      flex-wrap: wrap;
    }
    
    .status-indicator {
      width: 10px;
      height: 10px;
      border-radius: 50%;
    }
    
    .status-indicator.passed { background-color: var(--success-color); box-shadow: 0 0 8px var(--success-color); }
    .status-indicator.failed { background-color: var(--fail-color); box-shadow: 0 0 8px var(--fail-color); }
    
    .scenario-title {
      font-size: 1.05rem;
      font-weight: 600;
    }
    
    .scenario-tags {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }
    
    .tag {
      font-size: 0.75rem;
      padding: 2px 8px;
      border-radius: 4px;
      background: var(--bg-tertiary);
      color: var(--text-secondary);
      border: 1px solid rgba(255, 255, 255, 0.05);
    }
    
    .scenario-header-right {
      display: flex;
      align-items: center;
      gap: 15px;
    }
    
    .status-badge {
      font-size: 0.8rem;
      font-weight: bold;
      padding: 4px 10px;
      border-radius: 6px;
      text-transform: uppercase;
    }
    
    .status-badge.passed {
      color: var(--success-color);
      background-color: var(--success-bg);
      border: 1px solid var(--success-border);
    }
    
    .status-badge.failed {
      color: var(--fail-color);
      background-color: var(--fail-bg);
      border: 1px solid var(--fail-border);
    }

    .status-badge.skipped {
      color: #b45309;
      background-color: rgba(217, 119, 6, 0.12);
      border: 1px solid rgba(217, 119, 6, 0.35);
    }

    .status-indicator.skipped { background-color: #d97706; box-shadow: 0 0 8px #d97706; }

    .status-badge.changes {
      color: #2563eb;
      background-color: rgba(37, 99, 235, 0.12);
      border: 1px solid rgba(37, 99, 235, 0.35);
    }
    .changes-panel {
      margin: 0 16px 12px;
      padding: 12px 16px;
      border-radius: 8px;
      color: #1d4ed8;
      background-color: rgba(37, 99, 235, 0.08);
      border: 1px solid rgba(37, 99, 235, 0.25);
      font-size: 13px;
    }
    .changes-panel ul { margin: 6px 0 0; padding-left: 18px; }
    .changes-panel li { margin: 2px 0; }
    
    .scenario-duration {
      font-size: 0.85rem;
      color: var(--text-secondary);
    }
    
    .chevron {
      fill: var(--text-secondary);
      transition: transform 0.2s;
    }
    
    .scenario-card.open .chevron {
      transform: rotate(180deg);
    }
    
    .scenario-body {
      display: none;
      padding: 24px;
      border-top: 1px solid var(--border-color);
      background: var(--bg-primary);
    }
    
    .scenario-card.open .scenario-body {
      display: block;
    }
    
    /* Scenario Dimension Specs */
    .specs-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 15px;
      margin-bottom: 25px;
      background: var(--bg-secondary);
      padding: 15px 20px;
      border-radius: 8px;
      border: 1px solid var(--border-color);
    }
    
    .spec-item {
      display: flex;
      flex-direction: column;
    }
    
    .spec-label {
      font-size: 0.75rem;
      color: var(--text-muted);
      text-transform: uppercase;
      font-weight: 600;
    }
    
    .spec-value {
      font-size: 0.9rem;
      font-weight: 600;
      color: var(--text-primary);
    }
    
    /* Timeline / steps execution pipeline */
    .steps-timeline {
      display: flex;
      flex-direction: column;
      gap: 15px;
      position: relative;
      padding-left: 20px;
    }
    
    .steps-timeline::before {
      content: '';
      position: absolute;
      top: 10px;
      left: 4px;
      bottom: 10px;
      width: 2px;
      background-color: var(--border-color);
    }
    
    .step-item {
      position: relative;
    }
    
    .step-dot {
      position: absolute;
      left: -20px;
      top: 6px;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background-color: var(--border-color);
      border: 2px solid var(--bg-primary);
    }
    
    .step-item.passed .step-dot { background-color: var(--success-color); }
    .step-item.failed .step-dot { background-color: var(--fail-color); }
    
    .step-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      cursor: pointer;
      padding: 8px 12px;
      border-radius: 6px;
      transition: background-color 0.2s;
    }
    
    .step-header:hover {
      background-color: var(--bg-secondary);
    }
    
    .step-title {
      font-size: 0.95rem;
      font-weight: 500;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    
    .step-duration {
      font-size: 0.8rem;
      color: var(--text-secondary);
    }
    
    .step-details {
      display: none;
      margin-top: 10px;
      padding-left: 12px;
      margin-bottom: 15px;
    }
    
    .step-item.open .step-details {
      display: block;
    }
    
    /* Validations, Errors & Warnings inside step */
    .validation-row {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 0.8rem;
      margin-right: 15px;
      margin-bottom: 10px;
      padding: 3px 8px;
      border-radius: 4px;
      background: var(--bg-secondary);
    }
    
    .validation-val.passed { color: var(--success-color); }
    .validation-val.failed { color: var(--fail-color); }
    
    .message-box {
      border-radius: 8px;
      padding: 12px 16px;
      font-size: 0.85rem;
      margin-bottom: 15px;
      border: 1px solid;
    }
    
    .message-box.error {
      background-color: var(--fail-bg);
      border-color: var(--fail-border);
      color: var(--fail-color);
    }
    
    .message-box.warning {
      background-color: var(--warning-bg);
      border-color: var(--warning-border);
      color: var(--warning-color);
    }
    
    /* Request / Response payloads toggle view */
    .payload-toggle-row {
      display: flex;
      gap: 10px;
      margin-top: 15px;
    }
    
    .payload-btn {
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      color: var(--text-secondary);
      padding: 6px 12px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 0.8rem;
      font-weight: 500;
      transition: all 0.2s;
    }
    
    .payload-btn:hover {
      border-color: var(--accent-hover);
      color: var(--text-primary);
    }
    
    .payload-btn.active {
      background: var(--bg-tertiary);
      border-color: var(--accent-color);
      color: var(--text-primary);
    }
    
    .payload-container {
      display: none;
      margin-top: 10px;
      background: #060913;
      border: 1px solid var(--border-color);
      border-radius: 8px;
      padding: 15px;
      position: relative;
    }
    
    .payload-container.visible {
      display: block;
    }
    
    .payload-container pre {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.8rem;
      overflow-x: auto;
      max-height: 400px;
      color: #e2e8f0;
    }
    
    .copy-btn {
      position: absolute;
      top: 10px;
      right: 10px;
      background: var(--bg-tertiary);
      border: 1px solid var(--border-color);
      color: var(--text-secondary);
      font-size: 0.75rem;
      padding: 4px 8px;
      border-radius: 4px;
      cursor: pointer;
      z-index: 10;
    }
    
    .copy-btn:hover {
      background: var(--accent-color);
      color: #fff;
    }
    
    /* Footer styles */
    footer {
      text-align: center;
      padding: 40px 0;
      border-top: 1px solid var(--border-color);
      margin-top: 80px;
      font-size: 0.85rem;
      color: var(--text-muted);
    }
    
    /* Empty state */
    .empty-state {
      text-align: center;
      padding: 50px;
      color: var(--text-secondary);
      font-size: 1.1rem;
    }
  </style>
</head>
<body>
  <header>
    <div class="logo-area">
      <h1>✈ API Automation Dashboard</h1>
      <p>Continuous Verification Suite execution results</p>
    </div>
    <div>
      <span class="run-badge">RUN ID: ${runId}</span>
    </div>
  </header>

  <div class="main-container">
    <!-- Metrics Overview Grid -->
    <div class="metrics-grid">
      <div class="metric-card total">
        <div class="metric-label">Total Scenarios</div>
        <div class="metric-value">${totalScenarios}</div>
        <div class="metric-meta">
          <span>Env: ${env}</span>
          <span>Suite: ${suite}</span>
        </div>
      </div>
      
      <div class="metric-card passed">
        <div class="metric-label">Passed</div>
        <div class="metric-value" style="color: var(--success-color)">${passed}</div>
        <div class="metric-meta">
          <span>Target passed runs</span>
        </div>
      </div>
      
      <div class="metric-card failed">
        <div class="metric-label">Failed</div>
        <div class="metric-value" style="color: var(--fail-color)">${failed}</div>
        <div class="metric-meta">
          <span>Must be 0 for release</span>
        </div>
      </div>
      
      <div class="metric-card rate">
        <div class="metric-label">Pass Rate</div>
        <div class="metric-value" style="color: var(--warning-color)">${passRate}</div>
        <div class="metric-meta">
          <span>Duration: ${duration}</span>
        </div>
      </div>
    </div>

    <!-- Layout: Sidebar and Main Results -->
    <div class="dashboard-layout">
      <!-- Sidebar Info -->
      <div class="sidebar">
        <div class="card">
          <div class="card-title">Run Details</div>
          <ul class="info-list">
            <li class="info-item">
              <span class="info-key">Start Time</span>
              <span class="info-val">${timestamp}</span>
            </li>
            <li class="info-item">
              <span class="info-key">Environment</span>
              <span class="info-val" style="text-transform: uppercase;">${env}</span>
            </li>
            <li class="info-item">
              <span class="info-key">Suite Target</span>
              <span class="info-val" style="text-transform: uppercase;">${suite}</span>
            </li>
            <li class="info-item">
              <span class="info-key">Total Steps Run</span>
              <span class="info-val">${report.scenarios.reduce((acc, s) => acc + (s.steps?.length || 0), 0)}</span>
            </li>
          </ul>
        </div>

        <div class="card">
          <div class="card-title">Airline Coverage</div>
          <table class="airline-table">
            <thead>
              <tr>
                <th>Airline</th>
                <th>Runs</th>
                <th>Pass Rate</th>
              </tr>
            </thead>
            <tbody>
              ${Object.entries(report.airlineCoverageMetrics || {})
                .filter(([key]) => key !== 'summary')
                .map(([airline, metrics]) => `
                  <tr>
                    <td><span class="airline-badge">${airline}</span></td>
                    <td>${metrics.runs} (${metrics.passed}/${metrics.failed})</td>
                    <td style="color: ${metrics.failed > 0 ? 'var(--fail-color)' : 'var(--success-color)'}; font-weight: 600;">
                      ${metrics.passRate}
                    </td>
                  </tr>
                `).join('')}
            </tbody>
          </table>
        </div>
      </div>

      <!-- Test Cases Listing -->
      <div class="results-area">
        <div class="filter-bar">
          <input type="text" id="searchInput" class="search-input" placeholder="Search scenarios by name, ID, airline, or tags..." onkeyup="filterTests()">
          <div class="filter-buttons">
            <button class="filter-btn active" id="btn-all" onclick="setFilter('ALL')">All (${totalScenarios})</button>
            <button class="filter-btn" id="btn-passed" onclick="setFilter('PASSED')" style="border-bottom-color: var(--success-color)">Passed (${passed})</button>
            <button class="filter-btn" id="btn-failed" onclick="setFilter('FAILED')" style="border-bottom-color: var(--fail-color)">Failed (${failed})</button>
            <button class="filter-btn" id="btn-skipped" onclick="setFilter('SKIPPED')" style="border-bottom-color: var(--warn-color, #d97706)">Skipped (${skipped})</button>
          </div>
        </div>

        <div id="scenariosContainer">
          ${report.scenarios.map(s => {
            const hasDimensions = !!s.sectorType;
            return `
              <div class="scenario-card" data-status="${s.status}" data-search="${(s.name + ' ' + s.id + ' ' + (s.airline || '') + ' ' + (s.tags || []).join(' ')).toLowerCase()}">
                <div class="scenario-header" onclick="toggleScenario(this)">
                  <div class="scenario-header-left">
                    <div class="status-indicator ${s.status.toLowerCase()}"></div>
                    <span class="scenario-title">${s.name}</span>
                    <div class="scenario-tags">
                      ${(s.tags || []).map(t => `<span class="tag">${t}</span>`).join('')}
                    </div>
                  </div>
                  <div class="scenario-header-right">
                    ${(s.changesDetected && s.changesDetected.length) ? `<span class="status-badge changes" title="Itinerary changes accepted between search and pricing">⟳ ${s.changesDetected.length} change${s.changesDetected.length > 1 ? 's' : ''}</span>` : ''}
                    <span class="status-badge ${s.status.toLowerCase()}">${s.status}</span>
                    <span class="scenario-duration">${s.duration}</span>
                    <svg class="chevron" width="12" height="8" viewBox="0 0 12 8"><path d="M1 1l5 5 5-5" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>
                  </div>
                </div>
                ${(s.changesDetected && s.changesDetected.length) ? `
                <div class="changes-panel">
                  <strong>⟳ Changes accepted (search → priced):</strong>
                  <ul>${s.changesDetected.map(c => `<li>${c}</li>`).join('')}</ul>
                </div>` : ''}
                
                <div class="scenario-body">
                  ${hasDimensions ? `
                    <div class="specs-grid">
                      <div class="spec-item">
                        <span class="spec-label">Airline</span>
                        <span class="spec-value">${s.airline}</span>
                      </div>
                      <div class="spec-item">
                        <span class="spec-label">Trip Type</span>
                        <span class="spec-value">${s.tripType}</span>
                      </div>
                      <div class="spec-item">
                        <span class="spec-label">Sector Type</span>
                        <span class="spec-value">${s.sectorType}</span>
                      </div>
                      <div class="spec-item">
                        <span class="spec-label">Passenger Mix</span>
                        <span class="spec-value">${s.passengerMix}</span>
                      </div>
                      <div class="spec-item">
                        <span class="spec-label">Sector Pool</span>
                        <span class="spec-value" style="text-transform: capitalize;">${s.poolName}</span>
                      </div>
                      <div class="spec-item">
                        <span class="spec-label">Route Details</span>
                        <span class="spec-value">${s.routeInfo}</span>
                      </div>
                      <div class="spec-item">
                        <span class="spec-label">Transaction ID</span>
                        <span class="spec-value" style="font-family: monospace; font-size: 0.8rem;">${s.transactionId || 'N/A'}</span>
                      </div>
                    </div>
                  ` : ''}

                  <div class="steps-timeline">
                    ${(s.steps || []).map((step, stepIdx) => {
                      const isPassed = step.status === 'PASSED';
                      const hasValidations = step.validations && Object.keys(step.validations).length > 0;
                      const hasErrors = step.errors && step.errors.length > 0;
                      const hasWarnings = step.warnings && step.warnings.length > 0;
                      const hasReq = !!step.request;
                      const hasResp = !!step.response;

                      return `
                        <div class="step-item ${isPassed ? 'passed' : 'failed'}" id="step-${s.id}-${stepIdx}">
                          <div class="step-dot"></div>
                          <div class="step-header" onclick="toggleStep('${s.id}', ${stepIdx})">
                            <span class="step-title">
                              <span style="color: ${isPassed ? 'var(--success-color)' : 'var(--fail-color)'}">
                                ${isPassed ? '✓' : '✗'}
                              </span>
                              ${step.name}
                            </span>
                            <span class="step-duration">${step.duration}</span>
                          </div>

                          <div class="step-details">
                            ${hasValidations ? `
                              <div style="margin-bottom: 12px;">
                                <div style="font-size: 0.75rem; color: var(--text-muted); font-weight:600; text-transform:uppercase; margin-bottom:6px;">Validations</div>
                                ${Object.entries(step.validations).map(([vName, vStatus]) => `
                                  <span class="validation-row">
                                    <span>${vName}:</span>
                                    <span class="validation-val ${vStatus === 'PASSED' ? 'passed' : 'failed'}">${vStatus}</span>
                                  </span>
                                `).join('')}
                              </div>
                            ` : ''}

                            ${hasErrors ? `
                              <div class="message-box error">
                                <strong>Execution Errors:</strong>
                                <ul style="padding-left: 18px; margin-top: 5px;">
                                  ${step.errors.map(err => `<li>${err}</li>`).join('')}
                                </ul>
                              </div>
                            ` : ''}

                            ${hasWarnings ? `
                              <div class="message-box warning">
                                <strong>Warnings:</strong>
                                <ul style="padding-left: 18px; margin-top: 5px;">
                                  ${step.warnings.map(warn => `<li>${warn}</li>`).join('')}
                                </ul>
                              </div>
                            ` : ''}

                            ${hasReq || hasResp ? `
                              <div class="payload-toggle-row">
                                ${hasReq ? `<button class="payload-btn" onclick="togglePayload('${s.id}', ${stepIdx}, 'req')">Request Payload</button>` : ''}
                                ${hasResp ? `<button class="payload-btn" onclick="togglePayload('${s.id}', ${stepIdx}, 'resp')">Response Payload</button>` : ''}
                              </div>
                            ` : ''}

                            ${hasReq ? `
                              <div class="payload-container" id="payload-${s.id}-${stepIdx}-req">
                                <button class="copy-btn" onclick="copyToClipboard('${s.id}-${stepIdx}-req-pre')">Copy</button>
                                <pre id="payload-${s.id}-${stepIdx}-req-pre"><code>${this._stringifyPayloadForHtml(step.request)}</code></pre>
                              </div>
                            ` : ''}

                            ${hasResp ? `
                              <div class="payload-container" id="payload-${s.id}-${stepIdx}-resp">
                                <button class="copy-btn" onclick="copyToClipboard('${s.id}-${stepIdx}-resp-pre')">Copy</button>
                                <pre id="payload-${s.id}-${stepIdx}-resp-pre"><code>${this._stringifyPayloadForHtml(step.response)}</code></pre>
                              </div>
                            ` : ''}
                          </div>
                        </div>
                      `;
                    }).join('')}
                  </div>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    </div>
  </div>

  <footer>
    <p>© 2026 Airline API Automation Platform. Generated at ${new Date().toLocaleString()}</p>
  </footer>

  <script>
    let currentFilter = 'ALL';

    function toggleScenario(header) {
      const card = header.parentElement;
      card.classList.toggle('open');
    }

    function toggleStep(scenarioId, stepIdx) {
      const stepItem = document.getElementById('step-' + scenarioId + '-' + stepIdx);
      if (stepItem) {
        stepItem.classList.toggle('open');
      }
    }

    function togglePayload(scenarioId, stepIdx, type) {
      const container = document.getElementById('payload-' + scenarioId + '-' + stepIdx + '-' + type);
      const btn = event.currentTarget;
      
      // Toggle visibility
      container.classList.toggle('visible');
      btn.classList.toggle('active');
    }

    function copyToClipboard(elementId) {
      const text = document.getElementById(elementId).innerText;
      navigator.clipboard.writeText(text).then(() => {
        const btn = event.currentTarget;
        const originalText = btn.innerText;
        btn.innerText = 'Copied!';
        btn.style.backgroundColor = 'var(--success-color)';
        setTimeout(() => {
          btn.innerText = originalText;
          btn.style.backgroundColor = '';
        }, 1500);
      });
    }

    function setFilter(filter) {
      currentFilter = filter;
      
      document.getElementById('btn-all').classList.remove('active');
      document.getElementById('btn-passed').classList.remove('active');
      document.getElementById('btn-failed').classList.remove('active');
      
      document.getElementById('btn-' + filter.toLowerCase()).classList.add('active');
      
      filterTests();
    }

    function filterTests() {
      const search = document.getElementById('searchInput').value.toLowerCase();
      const cards = document.querySelectorAll('.scenario-card');

      cards.forEach(card => {
        const matchesStatus = (currentFilter === 'ALL') || (card.getAttribute('data-status') === currentFilter);
        const matchesSearch = card.getAttribute('data-search').includes(search);

        if (matchesStatus && matchesSearch) {
          card.style.display = 'block';
        } else {
          card.style.display = 'none';
        }
      });
    }
  </script>
</body>
</html>
`;
  }

  /** Returns the current run ID */
  getRunId() { return this._runId; }
}

module.exports = new ReportBuilder();
