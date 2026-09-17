const { v4: uuidv4 } = require('uuid');

/**
 * Resolves standard placeholders like {{futureDate}} and {{randomEmail}}
 */
const dataGenerator = {
  resolve(placeholder) {
    if (placeholder === '{{futureDate}}') {
      const date = new Date();
      date.setDate(date.getDate() + 7);
      return date.toISOString().split('T')[0];
    }
    
    if (placeholder === '{{randomEmail}}') {
      return `testuser_${Math.floor(Math.random() * 10000)}@example.com`;
    }

    if (placeholder === '{{uuid}}') {
      // If uuid is not installed, we can use a simpler random string
      return Math.random().toString(36).substring(2, 15);
    }

    return placeholder;
  }
};

module.exports = dataGenerator;
