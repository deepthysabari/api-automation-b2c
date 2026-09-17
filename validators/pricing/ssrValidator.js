'use strict';

const BaseValidator = require('../../airlines/base/BaseValidator');

/**
 * SsrValidator — Airline-agnostic check that GetSPricer's top-level SSR[]
 * array contains valid baggage (Code: "BAG") entries.
 *
 * Generic counterpart to the 6E-only IndiGoBaggageValidator ('6E_baggage').
 */
class SsrValidator extends BaseValidator {
  constructor() { super('ssr'); }

  validate(response, context, scenario, step) {
    if (step._stepKey !== 'getPrice') return this.pass();

    const data = response.data;
    if (!data || !Array.isArray(data.SSR)) {
      return this.warn('SSR field missing from GetSPricer response — baggage check skipped');
    }

    const baggageEntries = data.SSR.filter(s => s.Code === 'BAG');
    if (baggageEntries.length === 0) {
      return this.warn('No BAG SSR entries found in GetSPricer response');
    }

    const errors = [];
    baggageEntries.forEach((entry, i) => {
      if (!entry.Description) {
        errors.push(`SSR[${i}] BAG entry is missing Description`);
      }
      if (entry.Charge === undefined || entry.Charge === null) {
        errors.push(`SSR[${i}] BAG entry is missing Charge field`);
      }
    });

    return errors.length > 0 ? this.fail(...errors) : this.pass();
  }
}

module.exports = new SsrValidator();
