'use strict';

require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const scenarioRegistry = require('../scenarios/registry');
const scenarioFilter = require('../scenarios/filter');
const scenarioGenerator = require('../scenarios/generator');
const matrixGenerator = require('../scenarios/matrixGenerator');
const runner = require('../engine/runner');
const reportBuilder = require('../utils/reportBuilder');
const excelReportBuilder = require('../utils/excelReportBuilder');
const { classifyScenarioStatus } = require('../utils/scenarioStatus');
const bddInterpreter = require('../scenarios/bddInterpreter');
const { runWithConcurrency } = require('../utils/concurrency');
const config = require('../config/config');
const airlineResolver = require('../engine/airlineResolver');
const environmentStore = require('../config/environmentStore');
const apiClient = require('../utils/apiClient');

const app = express();
const PORT = process.env.PORT || 3000;

// HOST decides which network interfaces accept connections. Node's default is every
// interface, which is why the hosting guides lean on a firewall: the port answered anything
// that could route to the machine. Setting HOST=127.0.0.1 binds loopback only, so a reverse
// proxy becomes the sole way in and the firewall stops being the single point of failure.
// The default stays 0.0.0.0 so existing deployments keep working after an update.
const HOST = process.env.HOST || '0.0.0.0';

// Body parsing
app.use(express.json());

// CORS. The bundled UI is served by this same Express app, so it is same-origin and needs no
// CORS headers at all — which is why the default is now closed. It used to send
// Access-Control-Allow-Origin: * on every route, settings and run-control included, letting
// any page the operator happened to visit drive this server and read back credentials.
// Set CORS_ORIGIN to a specific origin (or '*' to restore the old behaviour) only when
// something genuinely external must call this API.
const CORS_ORIGIN = process.env.CORS_ORIGIN;
if (CORS_ORIGIN) {
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', CORS_ORIGIN);
    res.header('Vary', 'Origin');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, X-Reveal-Token');
    if (req.method === 'OPTIONS') {
      return res.sendStatus(200);
    }
    next();
  });
}

// Serve frontend UI
app.use(express.static(path.join(__dirname, '../ui')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../ui/index.html'));
});

// Scan features dynamically to map scenario IDs to stage names
const scenarioToStageMap = {};

function scanFeatureStages() {
  const featuresDir = path.join(__dirname, '../features');
  
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

  if (fs.existsSync(featuresDir)) {
    const featureFiles = getFilesRecursive(featuresDir, '.feature');
    featureFiles.forEach(filePath => {
      const parts = filePath.split(path.sep);
      let stageName = '';
      const stages = ["availability", "pricing", "ssr", "fare_rule", "travel_itinerary"];
      for (const part of parts) {
        const match = part.match(/^\d{2}_(.+)$/);
        if (match) {
          stageName = match[1];
          break;
        }
        if (stages.includes(part.toLowerCase())) {
          stageName = part.toLowerCase();
          break;
        }
      }

      if (stageName) {
        try {
          const bddScenarios = bddInterpreter.parseFile(filePath);
          bddScenarios.forEach(scenario => {
            scenarioToStageMap[scenario.id] = stageName;
          });
        } catch (err) {
          // Ignore parse errors on startup
        }
      }
    });
  }
}

// Initial scan
scanFeatureStages();

// Helper to determine the stage of a scenario
function getScenarioStage(scenario) {
  if (scenarioToStageMap[scenario.id]) {
    return scenarioToStageMap[scenario.id];
  }
  const stages = ["availability", "pricing", "ssr", "fare_rule", "travel_itinerary"];
  if (scenario.tags) {
    for (const tag of scenario.tags) {
      if (stages.includes(tag.toLowerCase())) {
        return tag.toLowerCase();
      }
    }
  }
  return "";
}

// Endpoint: GET /api/environment — current environment + which ones are usable.
// "configured" means every key a Signature call needs is present (environmentStore.REQUIRED_KEYS),
// not merely that a base URL exists — a live entry with a URL but no ApiKey/Password is exactly
// the half-configured state that used to fail at runtime with Permission Error 34.
app.get('/api/environment', (req, res) => {
  res.json({
    current: config.apiEnv,
    available: environmentStore.ENVIRONMENTS,
    liveConfigured: environmentStore.isConfigured('live'),
    betaConfigured: environmentStore.isConfigured('beta')
  });
});

// Endpoint: POST /api/environment — switch environment at runtime (no restart needed).
// Rejects mid-flight: switching while a run is in progress would let one scenario's steps
// span two environments' credentials/URLs.
app.post('/api/environment', (req, res) => {
  const { env } = req.body || {};
  const normalized = (env || '').toLowerCase();

  if (!['beta', 'live'].includes(normalized)) {
    return res.status(400).json({ error: `Unknown environment "${env}". Use "beta" or "live".` });
  }
  if (isRunActive) {
    return res.status(409).json({ error: 'Cannot switch environment while a run is in progress.' });
  }
  if (!environmentStore.isConfigured(normalized)) {
    const missing = environmentStore.missingKeys(normalized).join(', ');
    return res.status(400).json({
      error: `The "${normalized}" environment is not fully configured — missing: ${missing}. ` +
             `Set these in the Settings tab.`
    });
  }

  const applied = config.setApiEnv(normalized);
  console.log(`[Server] API environment switched to: ${applied}`);
  res.json({ current: applied });
});

// ── Settings: the per-environment URL + credential sets behind the environment switch.
// Values are owned by config/environmentStore.js (configs/environments.local.json over the .env
// seed). Secrets go out masked; the reveal route below serves plaintext for one key on demand.

// Endpoint: GET /api/settings — both environments, masked, for the Settings tab.
app.get('/api/settings', (req, res) => {
  const environments = {};
  environmentStore.ENVIRONMENTS.forEach(env => {
    environments[env] = {
      values: environmentStore.getMasked(env),
      configured: environmentStore.isConfigured(env),
      missing: environmentStore.missingKeys(env)
    };
  });
  res.json({
    current: config.apiEnv,
    keys: environmentStore.KEYS,
    secretKeys: environmentStore.SECRET_KEYS,
    requiredKeys: environmentStore.REQUIRED_KEYS,
    environments
  });
});

// ── Reveal password gate
//
// Viewing a stored credential in plaintext is the one action here that hands out a secret, so it
// sits behind a password the user sets. Unlocking mints a short-lived in-memory token; the token
// is what the reveal route checks, so the password crosses the wire once per session rather than
// once per field. Tokens live only in this process — a server restart re-locks everything.

const REVEAL_SESSION_MS = 15 * 60 * 1000;   // 15 minutes of inactivity
const revealSessions = new Map();           // token -> expiry timestamp

function issueRevealToken() {
  const token = crypto.randomBytes(32).toString('hex');
  revealSessions.set(token, Date.now() + REVEAL_SESSION_MS);
  return token;
}

/** Valid, unexpired token? Sliding expiry, so an active session doesn't drop mid-use. */
function hasValidRevealToken(req) {
  const token = req.get('x-reveal-token') || '';
  if (!token) return false;

  const expiry = revealSessions.get(token);
  if (!expiry) return false;
  if (Date.now() > expiry) {
    revealSessions.delete(token);
    return false;
  }

  revealSessions.set(token, Date.now() + REVEAL_SESSION_MS);
  return true;
}

// Drop expired tokens periodically so the map can't grow without bound. unref() so this timer
// never keeps the process alive on its own.
setInterval(() => {
  const now = Date.now();
  revealSessions.forEach((expiry, token) => {
    if (now > expiry) revealSessions.delete(token);
  });
}, REVEAL_SESSION_MS).unref();

// Endpoint: GET /api/settings/auth — is a password set, and is my current session still valid?
app.get('/api/settings/auth', (req, res) => {
  res.json({
    passwordSet: environmentStore.hasPassword(),
    unlocked: hasValidRevealToken(req)
  });
});

// Endpoint: POST /api/settings/auth/password — set or change the reveal password.
// Changing an existing password requires the current one (environmentStore enforces it).
app.post('/api/settings/auth/password', (req, res) => {
  const { password, currentPassword } = req.body || {};
  try {
    environmentStore.setPassword(password, currentPassword);
    // Every existing session is invalidated: changing the password must not leave older
    // sessions holding reveal access granted under the previous one.
    revealSessions.clear();
    console.log('[Server] Reveal password updated — existing reveal sessions cleared.');
    res.json({ passwordSet: true, token: issueRevealToken() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Endpoint: POST /api/settings/auth/clear — remove the gate (requires the current password).
app.post('/api/settings/auth/clear', (req, res) => {
  const { currentPassword } = req.body || {};
  try {
    environmentStore.clearPassword(currentPassword);
    revealSessions.clear();
    console.log('[Server] Reveal password cleared.');
    res.json({ passwordSet: false });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Endpoint: POST /api/settings/auth/unlock — exchange the password for a session token.
app.post('/api/settings/auth/unlock', (req, res) => {
  const { password } = req.body || {};

  if (!environmentStore.hasPassword()) {
    return res.status(400).json({ error: 'No reveal password is set. Set one first.' });
  }
  if (!environmentStore.verifyPassword(password)) {
    // Deliberately vague and uniform — no hint about which part was wrong.
    return res.status(401).json({ error: 'Incorrect password.' });
  }

  res.json({ token: issueRevealToken(), expiresInMs: REVEAL_SESSION_MS });
});

// Endpoint: POST /api/settings/auth/lock — end this reveal session immediately.
app.post('/api/settings/auth/lock', (req, res) => {
  const token = req.get('x-reveal-token') || '';
  if (token) revealSessions.delete(token);
  res.json({ unlocked: false });
});

// Endpoint: GET /api/settings/:env/reveal/:key — plaintext for ONE secret, for the eye toggle.
// Gated once a password is set. With no password set the gate is open — the Settings tab prompts
// to set one, but an unconfigured gate must not lock a user out of their own local .env values.
app.get('/api/settings/:env/reveal/:key', (req, res) => {
  const env = String(req.params.env || '').toLowerCase();
  const key = String(req.params.key || '');

  if (!environmentStore.ENVIRONMENTS.includes(env)) {
    return res.status(400).json({ error: `Unknown environment "${req.params.env}".` });
  }
  if (!environmentStore.KEYS.includes(key)) {
    return res.status(400).json({ error: `Unknown setting "${key}".` });
  }
  if (environmentStore.hasPassword() && !hasValidRevealToken(req)) {
    return res.status(401).json({ error: 'Locked — enter the reveal password to view credentials.', locked: true });
  }

  res.json({ key, value: environmentStore.getSecret(env, key) });
});

// Endpoint: POST /api/settings/:env — save one environment's settings.
// A secret submitted still masked means "unchanged" (environmentStore.save keeps the stored one).
// Rejects mid-run for the same reason POST /api/environment does: editing the ACTIVE environment
// re-applies it onto process.env, which would move a running scenario's credentials underneath it.
app.post('/api/settings/:env', (req, res) => {
  const env = String(req.params.env || '').toLowerCase();

  if (!environmentStore.ENVIRONMENTS.includes(env)) {
    return res.status(400).json({ error: `Unknown environment "${req.params.env}".` });
  }
  if (isRunActive) {
    return res.status(409).json({ error: 'Cannot change settings while a run is in progress.' });
  }

  const values = (req.body && req.body.values) || {};
  if (typeof values !== 'object' || Array.isArray(values)) {
    return res.status(400).json({ error: 'Expected a "values" object.' });
  }

  try {
    environmentStore.save(env, values);
    // Editing the environment currently in use must take effect immediately — otherwise the UI
    // would show saved values while the engine kept using the old ones.
    if (config.apiEnv === env) config.setApiEnv(env);

    console.log(`[Server] Settings saved for environment: ${env}`);
    res.json({
      env,
      values: environmentStore.getMasked(env),
      configured: environmentStore.isConfigured(env),
      missing: environmentStore.missingKeys(env),
      reapplied: config.apiEnv === env
    });
  } catch (err) {
    res.status(500).json({ error: `Failed to save settings: ${err.message}` });
  }
});

// Endpoint: POST /api/settings/:env/test — verify credentials with a REAL Signature call.
//
// Tests the values in the request body (falling back to what is stored) WITHOUT touching
// process.env, so an in-flight run's credentials are never disturbed and you can verify before
// committing to a save. Uses the same templates/6E/signature_request.json shape and the same
// live apiClient the engine uses — there is no mocked or simulated success path here.
app.post('/api/settings/:env/test', async (req, res) => {
  const env = String(req.params.env || '').toLowerCase();

  if (!environmentStore.ENVIRONMENTS.includes(env)) {
    return res.status(400).json({ error: `Unknown environment "${req.params.env}".` });
  }

  // Submitted values win, but a masked (unedited) secret falls back to what is stored.
  const stored = environmentStore.get(env);
  const submitted = (req.body && req.body.values) || {};
  const values = { ...stored };
  Object.entries(submitted).forEach(([key, value]) => {
    if (!environmentStore.KEYS.includes(key)) return;
    if (value === undefined || value === null) return;
    const str = String(value);
    if (str === '' || environmentStore.isMasked(str)) return;
    values[key] = str;
  });

  const missing = environmentStore.REQUIRED_KEYS.filter(key => !values[key]);
  if (missing.length > 0) {
    return res.status(400).json({
      ok: false,
      error: `Cannot test "${env}" — missing required values: ${missing.join(', ')}`,
      missing
    });
  }

  // B2C Signature only needs MerchantID + ApiKey — no Password/AgentCode/BrowserKey/agent
  // login, unlike the B2B project this engine was bootstrapped from.
  const payload = {
    MerchantID: values.MerchantID,
    ApiKey: values.ApiKey
  };

  const url = `${values.UtilsURLTest}/Utils/Signature`;
  const startedAt = Date.now();

  try {
    const response = await apiClient({
      method: 'POST',
      url,
      data: payload,
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000
    });

    const data = response.data || {};
    const code = String(data.Code ?? '');
    const msg = Array.isArray(data.Msg) ? data.Msg.join(', ') : (data.Msg || '');
    const tokenReceived = !!data.Token;

    res.json({
      ok: response.status === 200 && code === '200' && tokenReceived,
      env,
      url,
      httpStatus: response.status,
      code,
      // Reported verbatim — "Permission Error 34" is the diagnostic that matters here.
      msg,
      tokenReceived,
      elapsedMs: Date.now() - startedAt
    });
  } catch (err) {
    const data = err.response?.data || {};
    res.json({
      ok: false,
      env,
      url,
      httpStatus: err.response?.status || null,
      code: String(data.Code ?? ''),
      msg: Array.isArray(data.Msg) ? data.Msg.join(', ') : (data.Msg || err.message),
      tokenReceived: false,
      elapsedMs: Date.now() - startedAt
    });
  }
});

// Endpoint 1: GET /api/registry
app.get('/api/registry', (req, res) => {
  try {
    // The registry's nested (LCC / GDS / NDC) shape is owned by airlineResolver — ask it for the
    // flat code list and let it synthesise each profile (provider-derived carriers included).
    const airlines = {};

    for (const code of airlineResolver.getAllKnownCodes()) {
      const air = airlineResolver.getAirline(code);
      if (!air) continue;
      const tripTypes = ["OW", "RT"];
      if (air.supportsMC) {
        tripTypes.push("MC");
      }
      airlines[code] = {
        name: air.Name,
        isLcc: air.IsLcc,
        cabins: air.cabins || ["E"],
        sectorTypes: air.sectorTypes || ["DOM"],
        tripTypes: tripTypes
      };
    }

    // Build stages list dynamically from features/common/ directory
    const commonDir = path.join(__dirname, '../features/common');
    const stages = [];
    if (fs.existsSync(commonDir)) {
      const folders = fs.readdirSync(commonDir, { withFileTypes: true });
      folders.forEach(f => {
        if (f.isDirectory()) {
          const match = f.name.match(/^\d{2}_(.+)$/);
          if (match) {
            stages.push(match[1]);
          }
        }
      });
    }

    res.json({
      airlines,
      stages,
      sectorTypes: { DOM: "Domestic", INT: "International" },
      cabinLabels: { E: "Economy", B: "Business", PE: "Premium Economy", F: "First" },
      tripTypeLabels: { OW: "One Way", "RT": "Round Trip", "MC": "Multi City" }
    });
  } catch (err) {
    res.status(500).json({ error: `Failed to load registry: ${err.message}` });
  }
});

// Introspect each airline's customization surface from the codebase + registry.
function introspectAirlines() {
  // configs/airlines.json is nested (LCC / GDS / NDC) — airlineResolver owns that shape, so the
  // catalog is flattened through it: LCC codes keep their stored profile, and a carrier that only
  // appears in a GDS/NDC provider's airlines[] list gets the provider-derived profile.
  const codes = airlineResolver.getAllKnownCodes();
  const profiles = {};
  codes.forEach(code => { profiles[code] = airlineResolver.getAirline(code) || {}; });

  // Real category per carrier: LCC (direct integration) vs the GDS/NDC provider(s) selling it.
  // Replaces the old `IsLcc ? 'LCC' : 'GDS'` guess, which could never say "NDC".
  const providers = airlineResolver.getProviders();
  const categoryOf = code => {
    const list = profiles[code]._providers || [];
    if (list.length === 0) return 'LCC';
    // A carrier can sit under several providers; if they disagree, GDS wins as the broader channel.
    const cats = new Set(list.map(p => providers[p]?.category).filter(Boolean));
    return cats.has('GDS') ? 'GDS' : (cats.has('NDC') ? 'NDC' : 'GDS');
  };

  // Channel children grouped by their parent carrier (E6E/C6E/S6E -> 6E). Only LCC-bucket entries
  // have a parent — a GDS/NDC provider is a third party, not one airline's own channel.
  const childrenByParent = {};
  codes.forEach(code => {
    const parent = profiles[code].parent;
    if (parent) (childrenByParent[parent] = childrenByParent[parent] || []).push(code);
  });

  // Live scenario coverage per airline + stage (same source the runner uses).
  const coverage = {};
  try {
    const staticScenarios = scenarioRegistry.loadAll().getAll();
    let dynamic = [];
    try { matrixGenerator.init(); dynamic = (matrixGenerator.generate('smoke').scenarios) || []; } catch (_) {}
    [...staticScenarios, ...dynamic].forEach(s => {
      const code = s.dimensions && s.dimensions.airline;
      if (!code) return;
      const stage = getScenarioStage(s) || 'other';
      const c = coverage[code] = coverage[code] || { total: 0, stages: {} };
      c.total++;
      c.stages[stage] = (c.stages[stage] || 0) + 1;
    });
  } catch (_) {}

  const adapterExists = (code) => fs.existsSync(path.join(__dirname, '../airlines', code, 'adapter.js'));

  const airlines = codes.map(code => {
    const a = profiles[code];
    const dir = path.join(__dirname, '../airlines', code);
    const hasOwnAdapter = adapterExists(code);
    const hasFareRules = fs.existsSync(path.join(dir, 'fareRules.js'));

    // Custom validators: BaseValidator subclasses declare their id via super('name').
    let customValidators = [];
    const validatorsFile = path.join(dir, 'validators.js');
    if (fs.existsSync(validatorsFile)) {
      const src = fs.readFileSync(validatorsFile, 'utf8');
      const re = /super\(\s*['"]([^'"]+)['"]\s*\)/g;
      const set = new Set();
      let m;
      while ((m = re.exec(src))) set.add(m[1]);
      customValidators = [...set];
    }

    // Optional per-airline config.json extras (fare product classes, fare types).
    let carrierType = null, fareTypes = null, productClasses = null;
    const cfgFile = path.join(dir, 'config.json');
    if (fs.existsSync(cfgFile)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
        carrierType = cfg.type || null;
        fareTypes = cfg.fareTypes || null;
        if (cfg.productClasses) {
          productClasses = {};
          for (const [cabin, list] of Object.entries(cfg.productClasses)) {
            productClasses[cabin] = (list || []).map(p => ({
              code: p.code, name: p.name, channel: p.channel,
              special: !!p.special, condition: p.condition || null
            }));
          }
        }
      } catch (_) {}
    }

    let adapterType = 'generic';
    if (hasOwnAdapter) adapterType = 'own';
    else if (a.parent && adapterExists(a.parent)) adapterType = 'inherited';

    const cov = coverage[code] || { total: 0, stages: {} };

    const category = categoryOf(code);
    const providerCodes = a._providers || [];

    return {
      code,
      name: a.Name,
      isLcc: !!a.IsLcc,
      channel: category, // real category now: LCC | GDS | NDC (was an IsLcc-based guess)
      category,
      providers: providerCodes.map(p => ({
        code: p,
        name: providers[p]?.Name || p,
        category: providers[p]?.category || null
      })),
      supportsMC: !!a.supportsMC,
      supportsSSR: !!a.supportsSSR,
      supportsPaidSSR: !!a.supportsPaidSSR,
      supportsInfant: !!a.supportsInfant,
      sectorTypes: a.sectorTypes || [],
      cabins: a.cabins || [],
      parent: a.parent || null,
      isChannel: !!a.parent,
      channels: (childrenByParent[code] || []).map(c => ({ code: c, name: profiles[c].Name })),
      adapterType,
      hasFareRules,
      customValidators,
      carrierType,
      fareTypes,
      productClasses,
      scenarioCount: cov.total,
      stageCoverage: cov.stages
    };
  });

  const mainline = airlines.filter(a => !a.isChannel);
  const summary = {
    total: airlines.length,
    mainline: mainline.length,
    channels: airlines.filter(a => a.isChannel).length,
    withOwnAdapter: mainline.filter(a => a.adapterType === 'own').length,
    withCustomValidators: airlines.filter(a => a.customValidators.length > 0).length,
    lcc: mainline.filter(a => a.channel === 'LCC').length,
    gds: mainline.filter(a => a.channel === 'GDS').length,
    ndc: mainline.filter(a => a.channel === 'NDC').length
  };

  return { airlines, summary, providers };
}

// Endpoint: GET /api/airlines — per-airline customization catalog
app.get('/api/airlines', (req, res) => {
  try {
    res.json(introspectAirlines());
  } catch (err) {
    res.status(500).json({ error: `Failed to introspect airlines: ${err.message}` });
  }
});

// Endpoint: GET /api/suites — list named suites from suites/*.json for the Suite dropdown.
app.get('/api/suites', (req, res) => {
  try {
    const suitesDir = path.join(__dirname, '../suites');
    const suites = [];
    if (fs.existsSync(suitesDir)) {
      fs.readdirSync(suitesDir)
        .filter(f => f.endsWith('.json'))
        .forEach(f => {
          try {
            const data = JSON.parse(fs.readFileSync(path.join(suitesDir, f), 'utf8'));
            suites.push({
              id: path.basename(f, '.json'),
              name: data.name || path.basename(f, '.json'),
              description: data.description || '',
              scenarioCount: Array.isArray(data.scenarios) ? data.scenarios.length : 0
            });
          } catch (_) {
            // Skip an unparsable suite file rather than failing the whole listing.
          }
        });
    }
    suites.sort((a, b) => a.name.localeCompare(b.name));
    res.json({ suites });
  } catch (err) {
    res.status(500).json({ error: `Failed to list suites: ${err.message}` });
  }
});

// Load and filter scenarios helper
function getFilteredScenarios(params) {
  const { airline, stage, sector, cabin, tripType, suite } = params;

  // Ensure matrix is initialized
  matrixGenerator.init();

  // Load Gherkin scenarios + dynamic matrix scenarios
  const staticScenarios = scenarioRegistry.loadAll().getAll();
  const { scenarios: dynamicScenarios } = matrixGenerator.generate('smoke');
  const allScenarios = [...staticScenarios, ...dynamicScenarios];

  // Map filters
  let filtered = scenarioFilter.apply(allScenarios, {
    suite: suite || null,
    airline: airline || null,
    tripType: tripType || null,
    sectorType: sector || null
  });

  if (cabin) {
    filtered = filtered.filter(s => s.dimensions && s.dimensions.cabinClass === cabin.toUpperCase());
  }

  if (stage) {
    filtered = filtered.filter(s => getScenarioStage(s) === stage.toLowerCase());
  }

  return filtered;
}

// Endpoint 2: GET /api/scenarios
app.get('/api/scenarios', (req, res) => {
  try {
    const filtered = getFilteredScenarios(req.query);
    const scenarios = filtered.map(s => ({
      id: s.id,
      name: s.name,
      airline: s.dimensions?.airline || "",
      stage: getScenarioStage(s),
      tags: s.tags || []
    }));

    res.json({
      count: scenarios.length,
      scenarios
    });
  } catch (err) {
    res.status(500).json({ error: `Failed to fetch scenarios: ${err.message}` });
  }
});

// Map a reportBuilder scenario record to the shape the UI expects.
//
// A SKIPPED scenario (not applicable to this route/carrier — e.g. no live inventory) still
// carries its skip reason in the same `step.errors` array a genuine failure uses (see
// engine/runner.js's catch block, which pushes err.message regardless of SKIPPED vs FAILED).
// The scenario-level `s.status`/step-level `step.status` is the authoritative signal and MUST
// be checked before falling back to "any errors present = fail", or every legitimate skip
// renders as a false failure.
function mapScenarioForResponse(s) {
  const status = classifyScenarioStatus(s);
  const stepErrors = s.steps.flatMap(step => step.errors || []);
  const stepWarnings = s.steps.flatMap(step => step.warnings || []);

  const steps = (s.steps || []).map(step => {
    let stepStatus = 'pass';
    if (step.status === 'SKIPPED') {
      stepStatus = 'skip';
    } else if (step.status === 'FAILED' || (step.errors && step.errors.length > 0)) {
      stepStatus = 'fail';
    } else if (step.warnings && step.warnings.length > 0) {
      stepStatus = 'warn';
    }

    let durationMs = 0;
    if (typeof step.duration === 'string') {
      durationMs = Math.round(parseFloat(step.duration) * 1000) || 0;
    } else if (typeof step.duration === 'number') {
      durationMs = step.duration;
    }

    return {
      name: step.name,
      status: stepStatus,
      duration: durationMs,
      request: {
        method: step.request?.method || 'POST',
        url: step.request?.url || '',
        headers: step.request?.headers || {},
        body: step.request?.body || {}
      },
      response: {
        statusCode: step.response?.status || 0,
        body: step.response?.body || {}
      },
      validators: step.validatorResults || []
    };
  });

  return {
    id: s.id,
    name: s.name,
    status,
    duration: s.duration,
    warnings: stepWarnings,
    errors: stepErrors,
    steps
  };
}

// Endpoint 3: POST /api/run — kicks off the run and returns immediately; the UI polls
// GET /api/run/status for progress. A run of 90+ scenarios can take 10+ minutes, and holding
// a single HTTP request open that long is fragile over real networks (Wi-Fi NAT idle timeouts,
// proxies, a backgrounded browser tab) — any drop surfaces client-side as a bare "NetworkError"
// even though the run is still executing fine server-side. Polling avoids depending on one
// long-lived connection.
let isRunActive = false;
let currentRunTotal = 0;

app.post('/api/run', (req, res) => {
  if (isRunActive) {
    return res.status(409).json({ error: 'A run is already in progress.' });
  }

  let filtered, testCases;
  try {
    filtered = getFilteredScenarios(req.body);
    if (filtered.length === 0) {
      return res.status(400).json({ error: 'No scenarios matched the selected filters.' });
    }
    testCases = scenarioGenerator.buildAll(filtered);
  } catch (err) {
    return res.status(500).json({ error: `Failed to prepare run: ${err.message}` });
  }

  isRunActive = true;
  currentRunTotal = testCases.length;
  reportBuilder.init(testCases.map(t => t.id));
  const runId = reportBuilder._runId;

  res.json({ runId, total: testCases.length });

  // Default lowered 3 -> 2, matching jest.config.js/scenarioEngine.js — see jest.config.js's
  // own comment for why.
  const concurrency = Math.max(1, parseInt(process.env.CONCURRENCY, 10) || 2);
  runWithConcurrency(testCases, concurrency, async (testCase) => {
    try {
      await runner.runTestCase(testCase);
    } catch (err) {
      // Ignored here because runner.runTestCase records the failed result
      // on reportBuilder automatically before throwing.
    }
  })
    .catch(err => console.error(`[Server] Run ${runId} crashed: ${err.message}`))
    .finally(() => {
      reportBuilder.finalize();
      isRunActive = false;
    });
});

// Endpoint: GET /api/run/status — poll progress of the current (or most recently finished)
// run. Scenarios accumulate in reportBuilder as each one completes, so this reflects live
// progress, not just the final result.
app.get('/api/run/status', (req, res) => {
  const scenarios = reportBuilder._scenarios.map(mapScenarioForResponse);
  const total = isRunActive ? currentRunTotal : scenarios.length;
  const passed = scenarios.filter(s => s.status === 'pass').length;
  const warned = scenarios.filter(s => s.status === 'warn').length;
  const failed = scenarios.filter(s => s.status === 'fail').length;
  const skipped = scenarios.filter(s => s.status === 'skip').length;

  res.json({
    runId: reportBuilder.getRunId(),
    running: isRunActive,
    total,
    completed: scenarios.length,
    passed,
    warned,
    failed,
    skipped,
    scenarios
  });
});

// Endpoint: GET /api/run/export — download the current (or most recently finished) run as a
// .xlsx Test Execution Report (Summary sheet + per-scenario Test Cases sheet). Reads directly
// from reportBuilder._scenarios (raw, in-memory scenarioResult objects) rather than a
// finalize()'d/re-loaded JSON report, since the raw objects still carry `scenario.priority` —
// the serialized report on disk drops it (see utils/excelReportBuilder.js's doc comment).
app.get('/api/run/export', async (req, res) => {
  if (isRunActive) {
    return res.status(409).json({ error: 'Cannot export while a run is in progress — wait for it to finish.' });
  }
  const scenarios = reportBuilder._scenarios;
  if (!scenarios || scenarios.length === 0) {
    return res.status(400).json({ error: 'No completed run to export yet — run some scenarios first.' });
  }

  try {
    const runId = reportBuilder.getRunId() || 'run';
    const buffer = await excelReportBuilder.buildWorkbook(scenarios, runId);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="TestExecutionReport_${runId}.xlsx"`);
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: `Failed to build export: ${err.message}` });
  }
});

// Express error handler. Must be declared after every route: Express recognises a
// four-argument middleware as the error path and sends anything a route throws (or passes to
// next(err)) here. Without it an unexpected throw left the client waiting on a socket that
// never answered, and Express's fallback leaked a stack trace to the browser.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(`[Server] Unhandled error on ${req.method} ${req.originalUrl}: ${err.stack || err.message}`);
  if (res.headersSent) {
    return next(err);
  }
  // The message is deliberately generic — route errors here can carry credential values
  // from a failed live call. The detail goes to the log, where the operator can read it.
  res.status(500).json({ error: 'Internal server error. Check the server log for details.' });
});

// Start Server
app.listen(PORT, HOST, () => {
  console.log(`[Server] Test Runner backend running on ${HOST}:${PORT}`);
});

// ── Process-level safety nets
//
// A rejected promise outside a route — a runner or adapter failing between awaits — used to
// take the process down with no explanation in the log. systemd and NSSM restart it, so the
// crash itself is survivable; the cost is a run in flight, because reportBuilder.finalize()
// only writes reports/RUN_*.json once the last scenario completes. Logging the reason turns
// a silent restart into something diagnosable.
process.on('unhandledRejection', (reason) => {
  const detail = reason instanceof Error ? (reason.stack || reason.message) : String(reason);
  console.error(`[Server] Unhandled promise rejection: ${detail}`);
  if (isRunActive) {
    console.error('[Server] A scenario run was in progress — its report will not be written.');
  }
});

// An uncaught exception leaves the process in an undefined state, so this logs and exits
// rather than limping on: the service manager restarts a clean process, which is the
// recoverable outcome. Exit code 1 is what marks it a failure to systemd and NSSM.
process.on('uncaughtException', (err) => {
  console.error(`[Server] Uncaught exception: ${err.stack || err.message}`);
  process.exit(1);
});

// Stop cleanly on `systemctl stop` / `nssm stop` so an interrupted run is recorded as
// interrupted rather than vanishing without a trace.
['SIGTERM', 'SIGINT'].forEach(signal => {
  process.on(signal, () => {
    console.log(`[Server] ${signal} received — shutting down.`);
    if (isRunActive) {
      console.warn('[Server] Shutting down mid-run — this run\'s report will not be written.');
    }
    process.exit(0);
  });
});
