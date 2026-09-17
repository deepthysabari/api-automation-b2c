require('dotenv').config();

const environmentStore = require('./environmentStore');

// API_ENV selects which credential set the rest of the engine sees. setApiEnv() overlays that
// environment's values onto the exact process.env keys the engine already reads —
// airlines/registry.js (authUrlEnvKey/flightUrlEnvKey) and executor.js's {{...}} placeholder
// fallback — so switching environments needs no change outside this file. It re-applies at
// runtime (see server/index.js's /api/environment route) so the UI can flip environments
// without restarting the process.
//
// The values come from config/environmentStore.js, which resolves the UI-editable
// configs/environments.local.json over the .env seed. The switchable set is the whole
// credential set (URLs + MerchantID + ApiKey) so an environment is one coherent unit —
// see environmentStore.js's header comment for why that matters.
const SWITCHABLE_KEYS = environmentStore.KEYS;

// .env's own values are snapshotted once at startup so a switch back to beta is exact even
// after live has overwritten process.env.
const BETA_VALUES = {};
SWITCHABLE_KEYS.forEach(key => { BETA_VALUES[key] = process.env[key]; });

function setApiEnv(env) {
  const normalized = (env || 'beta').toLowerCase();
  const values = environmentStore.get(normalized);

  SWITCHABLE_KEYS.forEach(key => {
    const value = values[key];
    if (value) {
      process.env[key] = value;
    } else if (normalized === 'live') {
      // An unconfigured live key is blanked, never left holding whatever the previous
      // environment put there — silently inheriting beta's credentials at a production URL is
      // the exact failure this rewrite exists to remove. An empty value fails loudly instead.
      process.env[key] = '';
    } else if (BETA_VALUES[key] !== undefined) {
      process.env[key] = BETA_VALUES[key];
    }
  });

  config.apiEnv = normalized;
  config.baseUrl = process.env.BASE_URL || config.baseUrl;
  return normalized;
}

const config = {
  baseUrl: process.env.BASE_URL || 'https://api.example-travel.com',
  token: process.env.TOKEN,
  apiEnv: (process.env.API_ENV || 'beta').toLowerCase(),
  env: process.env.ENV || 'dev',
  debug: process.env.DEBUG === 'true',
  setApiEnv,

  // Lets the network/API team identify this tool's traffic on every live request — see
  // utils/apiClient.js's request interceptor, which attaches this on the shared Axios
  // instance every call goes through. Header name/value are both configurable so they can
  // be changed to whatever the API team's gateway expects without a code change.
  clientAppHeaderName: process.env.CLIENT_APP_HEADER_NAME || 'X-Client-App',
  clientAppHeaderValue: process.env.CLIENT_APP_HEADER_VALUE || 'api-automation-b2c'
};

setApiEnv(config.apiEnv);

module.exports = config;
