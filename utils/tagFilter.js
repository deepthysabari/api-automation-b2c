'use strict';

/**
 * Tag Filter Utility
 * 
 * Supports complex boolean logic for filtering by tags.
 * Input expression format:
 *   - AND condition: Comma separated (e.g., "smoke,domestic")
 *   - OR condition: Pipe separated within an AND segment (e.g., "oneway|roundtrip")
 *   - NOT condition: Prefix with ~ or - (e.g., "~flaky")
 * 
 * Example:
 *   "regression,domestic|international,~flaky"
 *   -> (Must have 'regression') AND (Must have 'domestic' OR 'international') AND (Must NOT have 'flaky')
 */

class TagFilter {
  /**
   * Evaluate if a list of scenario tags matches the filter expression.
   * 
   * @param {string} expression - The tag expression (e.g., "smoke,domestic|international,~flaky")
   * @param {string[]} scenarioTags - The tags assigned to the scenario
   * @returns {boolean} True if the scenario matches the expression
   */
  static evaluate(expression, scenarioTags) {
    if (!expression || expression.trim() === '') {
      return true; // Empty expression matches everything
    }

    // Normalize scenario tags to lowercase
    const normalizedTags = scenarioTags.map(t => t.toLowerCase());

    // Split expression into AND segments
    const andSegments = expression.split(',').map(s => s.trim()).filter(s => s.length > 0);

    for (const segment of andSegments) {
      // Split each AND segment into OR sub-segments
      const orTokens = segment.split('|').map(s => s.trim()).filter(s => s.length > 0);
      
      let segmentMatched = false;

      for (let token of orTokens) {
        token = token.toLowerCase();
        
        let isExclude = false;
        if (token.startsWith('~') || token.startsWith('-')) {
          isExclude = true;
          token = token.substring(1); // Remove the negation prefix
        }

        const tagExists = normalizedTags.includes(token);

        if (isExclude) {
          // If it's an exclude token and the tag exists, this OR condition is false (it FAILS the exclude)
          // For OR logic with excludes: e.g., "a|~b". If we have 'b', '~b' is false. If we don't have 'b', '~b' is true.
          if (!tagExists) {
            segmentMatched = true;
            break; // One OR condition matched, the segment is true
          }
        } else {
          // Normal include token
          if (tagExists) {
            segmentMatched = true;
            break; // One OR condition matched, the segment is true
          }
        }
      }

      // If any AND segment is entirely false, the whole expression fails
      if (!segmentMatched) {
        return false;
      }
    }

    // If we passed all AND segments, it's a match
    return true;
  }
}

module.exports = TagFilter;
