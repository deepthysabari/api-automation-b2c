const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const schemas = require('../validators/schemas');
const rules = require('../validators/rules');

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);

class ValidatorEngine {
  validate(step, response) {
    const expected = step.validations || step.validate;
    if (!expected) return;

    // 1. Status Code Validation
    if (expected.status && response.status !== expected.status) {
      throw new Error(`Status Code Mismatch. Expected: ${expected.status}, Got: ${response.status}`);
    }

    // 2. Schema Validation
    if (expected.schema) {
      const schema = schemas[expected.schema];
      if (!schema) throw new Error(`Schema definition not found: ${expected.schema}`);
      
      const validate = ajv.compile(schema);
      const valid = validate(response.data);
      if (!valid) {
        throw new Error(`Schema Validation Failed: ${ajv.errorsText(validate.errors)}`);
      }
    }

    // 3. Business Rules Validation
    if (expected.rules && Array.isArray(expected.rules)) {
      for (const rule of expected.rules) {
        const [ruleName, ...args] = rule.split(':');
        const ruleFn = rules[ruleName];
        if (!ruleFn) throw new Error(`Business rule not found: ${ruleName}`);
        
        const isValid = ruleFn(response, ...args);
        if (!isValid) {
          throw new Error(`Business Rule Failed: ${rule}`);
        }
      }
    }
  }
}

module.exports = new ValidatorEngine();
