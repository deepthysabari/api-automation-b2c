'use strict';

const createPaxCategoryValidator = require('./paxCategoryValidatorFactory');

/**
 * DefenceFareValidator — Confirms a defence fare search actually got back a defence fare in
 * the live GetExpSearch response.
 *
 * The request flag is `Parameters.PaxCategory: "DEF"` (given by the user, 2026-09-23 — same
 * mechanism as senior citizen/student fare). Live sampling so far found 0 DEF-tagged journeys
 * on every domestic route tried — genuinely thin/route-dependent inventory for this fare
 * category specifically, not a mechanism problem (the same PaxCategory approach is confirmed
 * working for SCP/STU). See docs/changes/2026-09-23-student-and-defence-fare.md. Shares its
 * implementation with seniorCitizenValidator/studentFareValidator via
 * paxCategoryValidatorFactory.js.
 */
module.exports = createPaxCategoryValidator({
  name: 'defenceFare',
  paxCategory: 'DEF',
  label: 'defence'
});
