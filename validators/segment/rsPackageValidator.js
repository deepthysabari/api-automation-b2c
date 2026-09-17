'use strict';

const BaseValidator = require('../../airlines/base/BaseValidator');

/**
 * RsPackageValidator — Validates the integrity of RS (Return Special) round-trip packages.
 *
 * Only runs when the scenario asked for the RS fare product. RS journeys are pre-combined
 * onward+return packages: the paired onward and return rows of one package carry the SAME
 * Index (e.g. "6E|37" on both legs). ReturnIdentifier is a COARSER grouping — one identifier
 * spans many packages, which is what lets the portal show a set of mappable returns once an
 * onward is picked — so it cannot identify a package on its own.
 *
 * Asserts:
 *   - the response actually came back as RS (journeys carry a non-zero ReturnIdentifier)
 *   - every onward package resolves to exactly one return leg (no ambiguity)
 *   - dangling packages (return leg absent) stay within provider-noise levels
 */
class RsPackageValidator extends BaseValidator {
  // Above this share of dangling packages, the fault is more likely ours than the provider's.
  static DANGLING_FAIL_THRESHOLD = 0.25;

  constructor() { super('rsPackage'); }

  validate(response, context, scenario, step) {
    const dims = scenario.dimensions || {};
    if (String(dims.fareProduct || '').toUpperCase() !== 'RS') return this.pass();
    if (step._stepKey !== 'getSearch') return this.pass();

    const trips = response.data?.Trips;
    if (!Array.isArray(trips) || trips.length < 2) {
      return this.fail('RS scenario did not return two trip legs');
    }

    const onward = trips[0].Journey || [];
    const returns = trips[1].Journey || [];

    const packages = onward.filter(j => Number(j.ReturnIdentifier ?? 0) > 0);
    if (packages.length === 0) {
      return this.fail(
        `Requested FareType "RS" but no packaged journeys came back: all ${onward.length} onward ` +
        `journey(s) carry ReturnIdentifier 0, which is the RT (normal fare) shape`
      );
    }

    // Index the return legs by their package key. Provider is kept defensively; Index already
    // embeds it.
    const key = j => `${j.Provider}|${j.Index}`;
    const returnsByPackage = new Map();
    returns.forEach(j => {
      if (Number(j.ReturnIdentifier ?? 0) > 0) {
        const k = key(j);
        if (!returnsByPackage.has(k)) returnsByPackage.set(k, []);
        returnsByPackage.get(k).push(j);
      }
    });

    const dangling = [];
    const ambiguous = [];

    packages.forEach(o => {
      const matches = returnsByPackage.get(key(o)) || [];
      if (matches.length === 0) {
        dangling.push(o);
      } else if (matches.length > 1) {
        ambiguous.push(`Index "${o.Index}" resolves to ${matches.length} return legs`);
      }
    });

    const errors = [];
    const warnings = [];

    // Ambiguity means the package key itself is wrong — two returns cannot both belong to one
    // onward. That is a defect in our pairing model, so it fails.
    if (ambiguous.length > 0) {
      errors.push(
        `${ambiguous.length} RS package(s) are ambiguous under Index: ` +
        `${ambiguous.slice(0, 3).join('; ')}${ambiguous.length > 3 ? ` (+${ambiguous.length - 3} more)` : ''}`
      );
    }

    // A dangling package is an onward row referencing a return leg the provider never sent.
    // Observed live: S6E returned 12 such rows out of 1,774 packages, inside a single poll — so
    // this is provider data noise, not an engine fault, and those packages are simply not
    // bookable. Warn rather than fail. But if a large share dangles, the pairing model is
    // suspect rather than the provider, so escalate.
    if (dangling.length > 0) {
      const share = dangling.length / packages.length;
      const byProvider = {};
      dangling.forEach(o => (byProvider[o.Provider] = (byProvider[o.Provider] || 0) + 1));
      const breakdown = Object.entries(byProvider).map(([p, n]) => `${p}:${n}`).join(', ');
      const detail =
        `${dangling.length} of ${packages.length} RS package(s) (${(share * 100).toFixed(1)}%) ` +
        `reference a return leg the provider did not return [${breakdown}] — not bookable`;

      if (share > RsPackageValidator.DANGLING_FAIL_THRESHOLD) {
        errors.push(`${detail}. That share is too high to be provider noise — the pairing key is suspect.`);
      } else {
        warnings.push(detail);
      }
    }

    if (errors.length > 0) return this.fail(...errors);

    const providers = [...new Set(packages.map(j => j.Provider))];
    const resolved = packages.length - dangling.length;
    const summary =
      `${resolved} of ${packages.length} RS package(s) across ${providers.length} provider(s) ` +
      `[${providers.join(', ')}] resolve to exactly one return leg.`;

    if (warnings.length > 0) return this.warn(...warnings.map(w => `${w}. ${summary}`));
    return this.pass(summary);
  }
}

module.exports = new RsPackageValidator();
