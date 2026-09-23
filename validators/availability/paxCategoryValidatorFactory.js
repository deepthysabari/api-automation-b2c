'use strict';

const BaseValidator = require('../../airlines/base/BaseValidator');

/**
 * createPaxCategoryValidator — Shared implementation behind seniorCitizenValidator,
 * studentFareValidator, defenceFareValidator (and any future fare-category flag).
 *
 * All of B2C's "special fare category" flags share one real mechanism, confirmed live
 * 2026-09-23 by a request/response the user captured directly against the beta API:
 * `Parameters.PaxCategory` — NOT the `IsSeniorCitizen`/`IsStudentFare` booleans this project
 * originally wired (confirmed dead: identical results with/without them, on marketplace and
 * preferred searches alike). Each category is just a different code:
 *   SCP — senior citizen
 *   STU — student
 *   DEF — defence
 * See docs/changes/2026-09-23-fare-category-paxcategory-fix.md /
 * docs/changes/2026-09-23-student-and-defence-fare.md.
 *
 * @param {Object} opts
 * @param {string} opts.name        - Registry name (e.g. 'seniorCitizen')
 * @param {string} opts.paxCategory - The PaxCategory code this validator confirms (e.g. 'SCP')
 * @param {string} opts.label       - Human-readable label for error/pass messages (e.g. 'senior-citizen')
 * @returns {BaseValidator}
 */
function createPaxCategoryValidator({ name, paxCategory, label }) {
  class PaxCategoryValidator extends BaseValidator {
    constructor() {
      super(name);
    }

    validate(response, context, scenario, step) {
      // Only run on the availability (GetExpSearch) step.
      if (step._stepKey !== 'getSearch') return this.pass();

      // No-op unless this scenario actually opted into this fare category.
      if (scenario?.dimensions?.paxCategory !== paxCategory) return this.pass();

      const data = response?.data;
      if (!data || !Array.isArray(data.Trips) || data.Trips.length === 0) {
        // Let the `availability` validator own the "no results at all" failure — nothing
        // category-specific to say if there is no data to look at.
        return this.pass();
      }

      const isMatch = journey => !!journey && journey.PaxCategory === paxCategory;
      const describe = journey => `PaxCategory="${journey.PaxCategory}", Index="${journey.Index}"`;

      // ── Path 1: a specific journey has already been selected upstream (context.Index /
      // context.ReturnIndex, the same keys IndiGoFareClassValidator reads at pricing time).
      const selectedIndex = context?.Index;
      if (selectedIndex) {
        const errors = [];
        let foundAny = false;

        data.Trips.forEach((trip, ti) => {
          const tripIndex = ti === 0 ? context.Index : (context.ReturnIndex || context.Index);
          if (!tripIndex) return;

          const selectedJourney = (trip.Journey || []).find(j => j.Index === tripIndex);
          if (!selectedJourney) return;

          foundAny = true;
          if (!isMatch(selectedJourney)) {
            errors.push(
              `Trip[${ti}] selected journey (Index "${tripIndex}") is not a ${label} fare ` +
              `even though ${label} fare search was enabled. Found: ${describe(selectedJourney)}`
            );
          }
        });

        if (foundAny) {
          return errors.length > 0 ? this.fail(...errors) : this.pass();
        }
        // selectedIndex was set but didn't resolve to any journey in this response — fall
        // through to the existence check below rather than silently passing.
      }

      // ── Path 2: no selected journey to point at yet (pure availability-stage scenario) —
      // assert that a bookable fare in this category EXISTS somewhere in the response. This is
      // an existence check, not a positional one: it does not care where in the array it sits.
      const allJourneys = [];
      data.Trips.forEach(trip => (trip.Journey || []).forEach(j => { if (j) allJourneys.push(j); }));

      const bookableMatches = allJourneys.filter(j => isMatch(j) && Number(j.NetFare) > 0);
      if (bookableMatches.length > 0) {
        return this.pass(`${bookableMatches.length} bookable ${label} fare(s) found in search results.`);
      }

      // Nothing bookable — but were there any matching-category journeys at all (even at 0 fare)?
      const anyMatched = allJourneys.filter(isMatch);
      if (anyMatched.length > 0) {
        return this.fail(
          `${label[0].toUpperCase()}${label.slice(1)} fare search was enabled but no BOOKABLE ${label} fare was returned. ` +
          `Found ${anyMatched.length} ${label}-flagged journey(s), all priced at 0: ` +
          anyMatched.slice(0, 3).map(describe).join('; ')
        );
      }

      const sample = allJourneys.slice(0, 3).map(describe).join('; ') || 'none';
      return this.fail(
        `${label[0].toUpperCase()}${label.slice(1)} fare search was enabled but no journey in the response was ` +
        `flagged as a ${label} fare (PaxCategory:"${paxCategory}"). Sample journey field values: ${sample}`
      );
    }
  }

  return new PaxCategoryValidator();
}

module.exports = createPaxCategoryValidator;
