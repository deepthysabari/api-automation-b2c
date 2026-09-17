'use strict';

const BaseValidator = require('../../airlines/base/BaseValidator');

/**
 * RulesValidator — Confirms GetSPricer returns actual fare-rule content
 * (data.Rules[]) for every leg/FUID present in the priced journey.
 *
 * Catches the "staging data gap" case where Rules is missing entirely
 * or a leg's Rule[] comes back empty.
 *
 * Mirrors validators/pricing/fareRuleValidator.js: content at this step
 * also comes in two valid shapes depending on provider —
 *   - Domestic LCC (e.g. QP, 6E): structured `Rule: [{ Head, Info: [...] }]`.
 *   - International GDS/NDC (e.g. Sabre NDC provider "SB"/1SN on MH, CX,
 *     SQ, SK, LO, AA): free-text `FareRuleText` (a full penalties/
 *     cancellation blob), with `Rule: []`.
 * A Rules entry is only truly empty if it has neither.
 */
class RulesValidator extends BaseValidator {
  constructor() { super('rules'); }

  validate(response, context, scenario, step) {
    if (step._stepKey !== 'getPrice') return this.pass();

    const data = response.data;
    if (!data) return this.pass();

    const fuids = new Set();
    (data.Trips || []).forEach(trip => {
      (trip.Journey || []).forEach(journey => {
        if (!journey) return;
        (journey.Segments || []).forEach(seg => {
          const fuid = seg?.Flight?.FUID;
          if (fuid !== undefined && fuid !== null) fuids.add(String(fuid));
        });
      });
    });

    if (fuids.size === 0) return this.pass();

    if (!Array.isArray(data.Rules) || data.Rules.length === 0) {
      return this.fail(`No Rules data returned in GetSPricer response for FUID(s): ${[...fuids].join(', ')}`);
    }

    const errors = [];
    const warnings = [];

    fuids.forEach(fuid => {
      // FUID on a Rules entry may be a single value ("1") or a comma-joined
      // list covering multiple legs at once ("1,2,3") for connecting itineraries.
      const ruleEntry = data.Rules.find(r =>
        String(r.FUID).split(',').map(s => s.trim()).includes(fuid)
      );
      if (!ruleEntry) {
        errors.push(`No Rules entry found for FUID ${fuid}`);
        return;
      }
      const hasStructuredRule = Array.isArray(ruleEntry.Rule) && ruleEntry.Rule.length > 0;
      const hasFreeText = typeof ruleEntry.FareRuleText === 'string' && ruleEntry.FareRuleText.trim().length > 0;

      if (!hasStructuredRule && !hasFreeText) {
        errors.push(`Rules entry for FUID ${fuid} has neither Rule[] nor FareRuleText — no fare rule data returned`);
        return;
      }

      if (hasStructuredRule) {
        const emptyHeads = ruleEntry.Rule.filter(r => !Array.isArray(r.Info) || r.Info.length === 0);
        if (emptyHeads.length > 0) {
          warnings.push(`FUID ${fuid}: Rule head(s) [${emptyHeads.map(h => h.Head).join(', ')}] have no Info entries`);
        }
      }
    });

    if (errors.length > 0) return this.fail(...errors);
    if (warnings.length > 0) return this.warn(...warnings);
    return this.pass();
  }
}

module.exports = new RulesValidator();
