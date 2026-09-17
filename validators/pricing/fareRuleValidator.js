'use strict';

const BaseValidator = require('../../airlines/base/BaseValidator');

/**
 * FareRuleValidator — Confirms the dedicated /Flights/FareRule endpoint
 * actually returns fare-rule content, rather than an empty or missing payload.
 *
 * Verified against live responses: Rules live per-segment at
 * Trips[].Journey[].Segments[].Rules[], keyed by the segment's FUID (a
 * comma-joined list for connecting legs). The content itself comes in either
 * of two shapes depending on provider, and BOTH are valid, non-empty content:
 *   - Domestic LCC (e.g. QP, 6E): structured `Rule: [{ Head, Info: [...] }]`,
 *     `FareRuleText: null`.
 *   - International GDS/consolidator (e.g. Provider "OD"/"OD1" on DEL-SIN):
 *     free-text `FareRuleText` (a full penalties/cancellation/children-discount
 *     blob), with `Rule: []` and `FareRuleRemarks: ""`.
 * A ruleBlock is only truly empty if it has neither.
 */
class FareRuleValidator extends BaseValidator {
  constructor() { super('fareRule'); }

  validate(response, context, scenario, step) {
    if (step._stepKey !== 'fareRule') return this.pass();

    const data = response.data;
    if (!data || !Array.isArray(data.Trips)) return this.pass();

    const segments = [];
    data.Trips.forEach(trip => {
      (trip.Journey || []).forEach(journey => {
        if (!journey) return;
        (journey.Segments || []).forEach(seg => segments.push(seg));
      });
    });

    if (segments.length === 0) return this.pass();

    const errors = [];
    const warnings = [];

    segments.forEach((seg, i) => {
      if (!Array.isArray(seg.Rules) || seg.Rules.length === 0) {
        errors.push(`Segment[${i}] (FUID ${seg.FUID}) has no Rules data returned in FareRule response`);
        return;
      }
      seg.Rules.forEach((ruleBlock, j) => {
        const hasStructuredRule = Array.isArray(ruleBlock.Rule) && ruleBlock.Rule.length > 0;
        const hasFreeText = typeof ruleBlock.FareRuleText === 'string' && ruleBlock.FareRuleText.trim().length > 0;

        if (!hasStructuredRule && !hasFreeText) {
          errors.push(`Segment[${i}].Rules[${j}] (${ruleBlock.OrginDestination || 'unknown route'}) has neither Rule[] nor FareRuleText — no fare rule data returned`);
          return;
        }

        if (hasStructuredRule) {
          const emptyHeads = ruleBlock.Rule.filter(r => !Array.isArray(r.Info) || r.Info.length === 0);
          if (emptyHeads.length > 0) {
            warnings.push(`Segment[${i}].Rules[${j}]: Rule head(s) [${emptyHeads.map(h => h.Head).join(', ')}] have no Info entries`);
          }
        }
      });
    });

    if (errors.length > 0) return this.fail(...errors);
    if (warnings.length > 0) return this.warn(...warnings);
    return this.pass();
  }
}

module.exports = new FareRuleValidator();
