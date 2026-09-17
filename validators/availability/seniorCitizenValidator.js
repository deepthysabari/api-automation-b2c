'use strict';

const BaseValidator = require('../../airlines/base/BaseValidator');

/**
 * SeniorCitizenValidator — Confirms a senior-citizen fare search actually got back a
 * senior-citizen fare in the live GetExpSearch response, rather than silently accepting
 * whatever came back once the `IsSeniorCitizen` request flag was set.
 *
 * Generic (not airline-namespaced): senior-citizen fare coverage is a request-flag/response-flag
 * contract shared by every carrier that supports it (6E, SG, QP, IX, ...), so this lives under
 * validators/availability alongside `availability`/`cabinClass`, not under airlines/<CODE>/.
 *
 * Live response contract (confirmed by the domain expert): the matched Journey carries
 *   IsSeniorCitizen: true
 *   FCType:  "SENIOR CITIZEN" (or a superset string containing it)
 *   FCGroup: "Senior Citizen Fare" (or a superset string containing it)
 *
 * Selection: mirrors airlines/6E/validators.js's IndiGoFareClassValidator — if a prior step
 * already saved a fare `Index` into context (e.g. via a `Trips[0].Journey[FCType="SENIOR
 * CITIZEN"].Index` save expression), that specific selected journey is checked, never
 * `Journey[0]` (see CLAUDE.md: never assert on array position). When no Index has been saved
 * yet — a pure availability-stage scenario that only searches and inspects the raw list, with
 * no pricing/save step — there is no single "selected" journey to point at, so instead this
 * asserts existence: at least one BOOKABLE (NetFare > 0) journey in the response is a genuine
 * senior-citizen fare. That still satisfies the live-only/no-fabrication rule: it asserts on
 * the real response, and fails outright if the flag produced no senior-citizen fare at all.
 */
class SeniorCitizenValidator extends BaseValidator {
  constructor() {
    super('seniorCitizen');
  }

  validate(response, context, scenario, step) {
    // Only run on the availability (GetExpSearch) step.
    if (step._stepKey !== 'getSearch') return this.pass();

    // No-op unless this scenario actually opted into senior-citizen fare search.
    if (scenario?.dimensions?.isSeniorCitizen !== true) return this.pass();

    const data = response?.data;
    if (!data || !Array.isArray(data.Trips) || data.Trips.length === 0) {
      // Let the `availability` validator own the "no results at all" failure — nothing
      // senior-citizen-specific to say if there is no data to look at.
      return this.pass();
    }

    const isSeniorCitizenMatch = journey => {
      if (!journey) return false;
      const fcType = String(journey.FCType || '').toLowerCase();
      const fcGroup = String(journey.FCGroup || '').toLowerCase();
      return journey.IsSeniorCitizen === true
        || fcType.includes('senior citizen')
        || fcGroup.includes('senior citizen');
    };

    const describe = journey =>
      `IsSeniorCitizen="${journey.IsSeniorCitizen}", FCType="${journey.FCType}", ` +
      `FCGroup="${journey.FCGroup}", Index="${journey.Index}"`;

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
        if (!isSeniorCitizenMatch(selectedJourney)) {
          errors.push(
            `Trip[${ti}] selected journey (Index "${tripIndex}") is not a senior-citizen fare ` +
            `even though senior citizen fare search was enabled. Found: ${describe(selectedJourney)}`
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
    // assert that a bookable senior-citizen fare EXISTS somewhere in the response. This is an
    // existence check, not a positional one: it does not care where in the array it sits.
    const allJourneys = [];
    data.Trips.forEach(trip => (trip.Journey || []).forEach(j => { if (j) allJourneys.push(j); }));

    const bookableSeniorCitizenFares = allJourneys.filter(j =>
      isSeniorCitizenMatch(j) && Number(j.NetFare) > 0
    );

    if (bookableSeniorCitizenFares.length > 0) {
      return this.pass(
        `${bookableSeniorCitizenFares.length} bookable senior-citizen fare(s) found in search results.`
      );
    }

    // Nothing bookable — but were there any senior-citizen-flagged journeys at all (even at
    // 0 fare)? Report whichever is more diagnosable.
    const anySeniorCitizenFlagged = allJourneys.filter(isSeniorCitizenMatch);
    if (anySeniorCitizenFlagged.length > 0) {
      return this.fail(
        `Senior citizen fare search was enabled but no BOOKABLE senior-citizen fare was returned. ` +
        `Found ${anySeniorCitizenFlagged.length} senior-citizen-flagged journey(s), all priced at 0: ` +
        anySeniorCitizenFlagged.slice(0, 3).map(describe).join('; ')
      );
    }

    const sample = allJourneys.slice(0, 3).map(describe).join('; ') || 'none';
    return this.fail(
      `Senior citizen fare search was enabled but no journey in the response was flagged as a ` +
      `senior-citizen fare (IsSeniorCitizen=true / FCType or FCGroup containing "senior citizen"). ` +
      `Sample journey field values: ${sample}`
    );
  }
}

module.exports = new SeniorCitizenValidator();
