'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * EnvironmentStore — the ONE place that owns configs/environments.local.json.
 *
 * That file holds the per-environment URL + credential sets the UI's Settings tab edits.
 * It is gitignored: `.env` is tracked in this repo, so credentials entered through the UI must
 * never be written there. No other module reads this file — mirroring how
 * engine/airlineResolver.js is the sole owner of configs/airlines.json.
 *
 * ── Every key, not just the URLs
 *
 * B2C's Signature request only needs MerchantID + ApiKey (no Password/AgentCode/BrowserKey —
 * see the Postman collection). Still keeping URLs and credentials in the SAME switchable set
 * as api-automation-node's fix for exactly this class of bug: a key with no LIVE_* variant
 * silently falls back to beta's value at a production URL when you switch environments. Small
 * credential set here, but the same "one coherent set, not a partial one" discipline applies.
 *
 * ── .env is the fallback seed, never the destination
 *
 * A key absent from the JSON falls back to the matching .env value (`LIVE_<KEY>` for live, bare
 * `<KEY>` for beta). That is what makes an existing checkout auto-load with nothing to re-enter.
 * A missing JSON file is the normal first-run state, not an error.
 */

const STORE_PATH = path.join(__dirname, '../configs/environments.local.json');

const ENVIRONMENTS = ['beta', 'live'];

/**
 * Every key that defines an environment. Names match the process.env keys the engine already
 * reads (airlines/registry.js's authUrlEnvKey/flightUrlEnvKey, and the executor's {{...}}
 * fallback), so nothing downstream of config.js changes.
 */
const KEYS = [
  'BASE_URL',
  'UtilsURLTest',
  'FlightURLTest',
  'AvlURLTest',
  'MerchantID',
  'ApiKey'
];

/** Keys masked in API responses. The rest (URLs, MerchantID) render in full. */
const SECRET_KEYS = ['ApiKey'];

const DEFAULTS = {};

/** Keys without which an environment cannot complete a Signature call. */
const REQUIRED_KEYS = ['BASE_URL', 'UtilsURLTest', 'FlightURLTest', 'MerchantID', 'ApiKey'];

const MASK = '••••';

/**
 * Reveal password. Stored under the top-level `_auth` key (never an environment name, so it can
 * not collide with beta/live) as a scrypt hash + random salt — the password itself is never
 * written to disk and cannot be recovered from the file, only verified against it.
 *
 * scrypt is deliberately slow, so a stolen configs/environments.local.json does not hand over the
 * password cheaply. Node's crypto covers this with no new dependency.
 *
 * Forgot it? Delete the `_auth` key from configs/environments.local.json — that clears the gate
 * without touching any stored credential. There is no recovery path by design: the file is local
 * and the credentials behind it are the actual secret.
 */
const AUTH_KEY = '_auth';
const SCRYPT_KEYLEN = 64;

class EnvironmentStore {
  constructor() {
    this._stored = null;   // raw JSON contents, or {} when the file is absent
  }

  /** Read the JSON off disk once, then serve from memory. */
  _load() {
    if (this._stored) return this._stored;
    try {
      if (fs.existsSync(STORE_PATH)) {
        this._stored = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')) || {};
      } else {
        this._stored = {};   // normal first-run state, not an error
      }
    } catch (err) {
      // A corrupt local file must not take the server down — fall back to .env and say so.
      console.error(`[EnvironmentStore] Could not read ${STORE_PATH}: ${err.message} — falling back to .env`);
      this._stored = {};
    }
    return this._stored;
  }

  /** The .env value backing `key` for `env` — LIVE_<KEY> for live, bare <KEY> for beta. */
  _fromEnvFile(env, key) {
    return env === 'live' ? process.env[`LIVE_${key}`] : process.env[key];
  }

  /**
   * Resolved values for one environment: stored JSON first, then the .env seed, then a
   * built-in default. Values are always strings ('' when nothing is configured).
   * @param {string} env 'beta' | 'live'
   * @returns {Object<string,string>}
   */
  get(env) {
    const stored = this._load()[env] || {};
    const out = {};
    KEYS.forEach(key => {
      const value = stored[key] !== undefined && stored[key] !== null && stored[key] !== ''
        ? stored[key]
        : this._fromEnvFile(env, key);
      out[key] = value !== undefined && value !== null ? String(value) : (DEFAULTS[key] || '');
    });
    return out;
  }

  /** Same as get(), with SECRET_KEYS reduced to `••••` + last 4 characters. */
  getMasked(env) {
    const values = this.get(env);
    const out = {};
    Object.entries(values).forEach(([key, value]) => {
      out[key] = SECRET_KEYS.includes(key) ? maskValue(value) : value;
    });
    return out;
  }

  /** Plaintext for a single secret — backs the UI's per-field reveal control. */
  getSecret(env, key) {
    if (!KEYS.includes(key)) return null;
    return this.get(env)[key] || '';
  }

  /** True when every key needed for a Signature call has a value. */
  isConfigured(env) {
    const values = this.get(env);
    return REQUIRED_KEYS.every(key => !!values[key]);
  }

  /** Which required keys are still empty — drives the UI's "not configured" detail. */
  missingKeys(env) {
    const values = this.get(env);
    return REQUIRED_KEYS.filter(key => !values[key]);
  }

  /**
   * Merge `values` into `env` and persist. A value that comes back still masked means the field
   * was never edited, so the stored secret is preserved rather than overwritten with `••••1234`.
   * @returns {Object<string,string>} the resolved values after saving
   */
  save(env, values) {
    if (!ENVIRONMENTS.includes(env)) {
      throw new Error(`Unknown environment "${env}"`);
    }

    const current = this.get(env);
    const stored = this._load();
    const next = { ...(stored[env] || {}) };

    KEYS.forEach(key => {
      if (!(key in values)) return;                 // absent = leave alone
      const incoming = values[key];
      if (incoming === undefined || incoming === null) return;
      const value = String(incoming);
      if (isMasked(value)) return;                  // unchanged secret
      if (value === current[key]) return;           // no-op
      next[key] = value;
    });

    stored[env] = next;
    this._write(stored);
    return this.get(env);
  }

  // ── Reveal password

  /** True when a reveal password has been set. */
  hasPassword() {
    const auth = this._load()[AUTH_KEY];
    return !!(auth && auth.hash && auth.salt);
  }

  /**
   * Set or change the reveal password. Changing an existing one requires the current password —
   * otherwise anyone who reached this endpoint could lock the owner out of their own credentials.
   * @throws {Error} when the current password is wrong or the new one is too short
   */
  setPassword(newPassword, currentPassword) {
    if (typeof newPassword !== 'string' || newPassword.length < 8) {
      throw new Error('Password must be at least 8 characters.');
    }
    if (this.hasPassword() && !this.verifyPassword(currentPassword)) {
      throw new Error('Current password is incorrect.');
    }

    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(newPassword, salt, SCRYPT_KEYLEN).toString('hex');

    const stored = this._load();
    stored[AUTH_KEY] = { salt, hash, updatedAt: new Date().toISOString() };
    this._write(stored);
  }

  /** Remove the gate. Requires the current password — same lockout reasoning as setPassword. */
  clearPassword(currentPassword) {
    if (!this.hasPassword()) return;
    if (!this.verifyPassword(currentPassword)) {
      throw new Error('Current password is incorrect.');
    }
    const stored = this._load();
    delete stored[AUTH_KEY];
    this._write(stored);
  }

  /** Constant-time password check. False (never a throw) when no password is set. */
  verifyPassword(password) {
    const auth = this._load()[AUTH_KEY];
    if (!auth || !auth.hash || !auth.salt) return false;
    if (typeof password !== 'string' || password === '') return false;

    const candidate = crypto.scryptSync(password, auth.salt, SCRYPT_KEYLEN);
    const expected = Buffer.from(auth.hash, 'hex');
    // timingSafeEqual throws on a length mismatch, so guard before comparing.
    if (candidate.length !== expected.length) return false;
    return crypto.timingSafeEqual(candidate, expected);
  }

  /** Atomic write — temp file + rename, so an interrupted save can't truncate the real file. */
  _write(stored) {
    const dir = path.dirname(STORE_PATH);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${STORE_PATH}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, STORE_PATH);
    this._stored = stored;
  }
}

/** `••••` + the last 4 characters, so a configured secret is recognisable without exposing it. */
function maskValue(value) {
  if (!value) return '';
  const str = String(value);
  return str.length <= 4 ? MASK : `${MASK}${str.slice(-4)}`;
}

/** True when a submitted value is one this API masked, i.e. the field was never edited. */
function isMasked(value) {
  return typeof value === 'string' && value.startsWith(MASK);
}

module.exports = new EnvironmentStore();
module.exports.KEYS = KEYS;
module.exports.SECRET_KEYS = SECRET_KEYS;
module.exports.REQUIRED_KEYS = REQUIRED_KEYS;
module.exports.ENVIRONMENTS = ENVIRONMENTS;
module.exports.maskValue = maskValue;
module.exports.isMasked = isMasked;
