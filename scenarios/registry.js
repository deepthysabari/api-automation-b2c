'use strict';

const fs = require('fs');
const path = require('path');
const bddInterpreter = require('./bddInterpreter');

/**
 * ScenarioRegistry — Loads and indexes all scenario definition JSON files.
 *
 * Scans scenarios/definitions/*.json and builds an in-memory index
 * keyed by scenario ID for fast lookup.
 */
class ScenarioRegistry {
  constructor() {
    this._scenarios = {};
    this._loaded = false;
  }

  /**
   * Load all scenario definitions from the definitions/ folder and any nested subdirectories.
   * @returns {ScenarioRegistry} (chainable)
   */
  loadAll() {
    if (this._loaded) return this;

    const scenariosDir = __dirname;
    
    // Recursive helper to find files by extension
    const getFilesRecursive = (dir, ext) => {
      let results = [];
      if (!fs.existsSync(dir)) return results;
      const list = fs.readdirSync(dir, { withFileTypes: true });
      list.forEach(entry => {
        const resPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          results = results.concat(getFilesRecursive(resPath, ext));
        } else if (entry.isFile() && entry.name.endsWith(ext)) {
          results.push(resPath);
        }
      });
      return results;
    };

    // Load Gherkin BDD Feature scenarios (BDD is now the single source of truth!)
    const featuresDir = path.join(__dirname, '../features');
    if (fs.existsSync(featuresDir)) {
      const featureFiles = getFilesRecursive(featuresDir, '.feature');
      featureFiles.forEach(filePath => {
        try {
          const bddScenarios = bddInterpreter.parseFile(filePath);
          bddScenarios.forEach(scenario => {
            this._validate(scenario, path.basename(filePath));
            // Scenario IDs are derived purely from the scenario's title text (see
            // bddInterpreter.js), with no file/airline scoping. Two scenarios anywhere under
            // features/ that end up with the same title collide, and a plain-object index
            // silently keeps only the last one loaded — a scenario can vanish from every run
            // with no error (found live: two nearby-airport Scenario Outline rows sharing one
            // un-parameterized title, one row never executed). Fail fast instead, per CLAUDE.md's
            // fail-fast convention elsewhere in this engine.
            if (this._scenarios[scenario.id]) {
              // A thrown Error here would just be caught and logged by this loop's own
              // try/catch below, letting the run continue with coverage missing — the exact
              // silent-drop failure mode this check exists to prevent. Hard-exit instead,
              // matching engine/airlineResolver.js's own fail-fast convention for load-time
              // configuration errors.
              console.error(
                `[ScenarioRegistry] FATAL: Duplicate scenario ID "${scenario.id}" (from title ` +
                `"${scenario.name}") in ${path.basename(filePath)} collides with one already ` +
                `loaded from ${this._scenarios[scenario.id]._sourceFile}. Scenario titles must ` +
                `be unique across the whole features/ tree — rename one.`
              );
              process.exit(1);
            }
            scenario._sourceFile = path.basename(filePath);
            this._scenarios[scenario.id] = scenario;
          });
        } catch (err) {
          console.error(`[ScenarioRegistry] Error loading Gherkin feature ${filePath}: ${err.message}`);
        }
      });
    }

    this._loaded = true;
    console.log(`[ScenarioRegistry] Loaded ${Object.keys(this._scenarios).length} BDD Gherkin scenarios`);
    return this;
  }

  /**
   * Get a single scenario by ID.
   * @param {string} id
   * @returns {Object}
   */
  getById(id) {
    if (!this._loaded) this.loadAll();
    const scenario = this._scenarios[id];
    if (!scenario) throw new Error(`[ScenarioRegistry] Scenario not found: ${id}`);
    return scenario;
  }

  /**
   * Get all loaded scenarios as an array.
   * @returns {Object[]}
   */
  getAll() {
    if (!this._loaded) this.loadAll();
    return Object.values(this._scenarios);
  }

  /**
   * Get all scenarios sorted by priority (ascending).
   * @returns {Object[]}
   */
  getAllSorted() {
    return this.getAll().sort((a, b) => (a.priority || 99) - (b.priority || 99));
  }

  /** @private */
  _validate(scenario, file) {
    const required = ['id', 'name', 'tags', 'dimensions', 'flow'];
    required.forEach(field => {
      if (scenario[field] === undefined) {
        throw new Error(`Scenario ${file} missing required field: "${field}"`);
      }
    });
    const dimRequired = ['sectorType', 'tripType', 'passengerMix', 'airline'];
    dimRequired.forEach(field => {
      if (scenario.dimensions[field] === undefined) {
        throw new Error(`Scenario ${file} missing dimensions.${field}`);
      }
    });
  }
}

module.exports = new ScenarioRegistry();
