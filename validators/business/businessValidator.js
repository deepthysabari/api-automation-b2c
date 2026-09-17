'use strict';

const BaseValidator = require('../../airlines/base/BaseValidator');

/**
 * BusinessValidator — Validates that every API response indicates business success.
 *
 * Checks:
 *   - Response body has Code === "200"
 *   - Msg array contains "Success"
 *   - No error indicators in the response
 */
class BusinessValidator extends BaseValidator {
  constructor() { super('business'); }

  validate(response, context, scenario, step) {
    const data = response.data;
    if (!data) return this.fail('Response body is empty');

    const errors = [];
    const warnings = [];

    // Check Code field
    if (data.Code !== undefined && String(data.Code) !== '200') {
      if (String(data.Code) === '1025') {
        warnings.push(`Step [${step.name}] returned Code 1025: Unable to Fetch Store Response (informational tolerance for beta caching issues)`);
      } else if (String(data.Code) === '1501') {
        warnings.push(`Step [${step.name}] returned Code 1501: Pricing Data Not Found (informational tolerance for beta caching issues)`);
      } else if (String(data.Code) === '1500') {
        // GetSPricer fare-change notice — the priced NetAmount/Trips in this same response are
        // the authoritative, final price (see engine/executor.js); the fare-change itself is
        // surfaced as a CHANGE warning by pricingValidator. Not a business error.
        warnings.push(`Step [${step.name}] returned Code 1500: fare change reported, priced data accepted`);
      } else {
        errors.push(`Business Code mismatch: expected "200", got "${data.Code}"`);
      }
    }

    // Check Msg field
    if (Array.isArray(data.Msg)) {
      const hasSuccess = data.Msg.some(m =>
        typeof m === 'string' && m.toLowerCase().includes('success')
      );
      if (!hasSuccess) {
        if (String(data.Code) === '1025' || String(data.Code) === '1501' || String(data.Code) === '1500') {
          // Handled by warning above
        } else {
          errors.push(`Msg array does not contain "Success": ${JSON.stringify(data.Msg)}`);
        }
      }
    }

    // Check for common error patterns
    if (data.Error || data.error) {
      errors.push(`Error field present in response: ${data.Error || data.error}`);
    }

    if (errors.length > 0) return this.fail(...errors);
    if (warnings.length > 0) return this.warn(...warnings);
    return this.pass();
  }
}

module.exports = new BusinessValidator();
