'use strict';

const createPaxCategoryValidator = require('./paxCategoryValidatorFactory');

/**
 * StudentFareValidator — Confirms a student fare search actually got back a student fare in
 * the live GetExpSearch response.
 *
 * The request flag is `Parameters.PaxCategory: "STU"` — captured directly from a real live
 * request by the user, 2026-09-23 (the `IsStudentFare` boolean this project originally wired
 * is confirmed dead — zero effect on the response either way). Verified live: 19/492 journeys
 * on a sampled COK-BLR search came back tagged `PaxCategory: "STU"`. Shares its implementation
 * with seniorCitizenValidator/defenceFareValidator via paxCategoryValidatorFactory.js.
 */
module.exports = createPaxCategoryValidator({
  name: 'studentFare',
  paxCategory: 'STU',
  label: 'student'
});
