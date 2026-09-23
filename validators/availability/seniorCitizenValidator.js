'use strict';

const createPaxCategoryValidator = require('./paxCategoryValidatorFactory');

/**
 * SeniorCitizenValidator — Confirms a senior-citizen fare search actually got back a
 * senior-citizen fare in the live GetExpSearch response, rather than silently accepting
 * whatever came back once the request was made.
 *
 * The request flag is `Parameters.PaxCategory: "SCP"` — captured directly from a real live
 * request/response by the user, 2026-09-23 (the `IsSeniorCitizen` boolean this validator
 * originally guarded on is confirmed dead — zero effect on the response either way). Shares
 * its implementation with studentFareValidator/defenceFareValidator via
 * paxCategoryValidatorFactory.js — see that file's own header for the full mechanism writeup.
 */
module.exports = createPaxCategoryValidator({
  name: 'seniorCitizen',
  paxCategory: 'SCP',
  label: 'senior-citizen'
});
