'use strict';

const BaseValidator = require('../../airlines/base/BaseValidator');

/**
 * FlightMatchValidator — Confirms the flight priced by GetSPricer (live call)
 * is the same flight that was selected during availability search.
 *
 * Availability's JourneyKey is a '~'-delimited list of comma-delimited legs:
 *   Airline,FlightNo,DepartureCode,ArrivalCode,DepartureTime,ArrivalTime,DepTerminal,ArrTerminal,Duration
 * Verified against real GetSPricer/SmartPricer responses to align 1:1, in
 * order, with the priced Journey's Segments[] array — including leg 1,
 * which the availability response's Connections[] array omits.
 */
class FlightMatchValidator extends BaseValidator {
  constructor() { super('flightMatch'); }

  _parseJourneyKey(journeyKey) {
    if (!journeyKey || typeof journeyKey !== 'string') return null;
    return journeyKey.split('~').filter(Boolean).map(leg => {
      const parts = leg.split(',');
      return {
        FlightNo: (parts[1] || '').trim(),
        DepartureCode: (parts[2] || '').trim(),
        ArrivalCode: (parts[3] || '').trim(),
        DepartureTime: (parts[4] || '').trim(),
        ArrivalTime: (parts[5] || '').trim()
      };
    });
  }

  validate(response, context, scenario, step) {
    if (step._stepKey !== 'getPrice') return this.pass();

    const data = response.data;
    if (!data || !Array.isArray(data.Trips)) return this.pass();

    const errors = [];
    const warnings = [];

    const checkTrip = (tripIndex, journeyKey) => {
      const selectedLegs = this._parseJourneyKey(journeyKey);
      if (!selectedLegs || selectedLegs.length === 0) {
        warnings.push(`Trip[${tripIndex}]: no selected JourneyKey captured from availability — skipping flight-identity match`);
        return;
      }

      const pricedSegments = data.Trips[tripIndex]?.Journey?.[0]?.Segments || [];
      if (pricedSegments.length !== selectedLegs.length) {
        errors.push(`Trip[${tripIndex}]: leg count mismatch — availability selected ${selectedLegs.length}, GetSPricer returned ${pricedSegments.length}`);
        return;
      }

      selectedLegs.forEach((selLeg, si) => {
        const pricedFlight = pricedSegments[si]?.Flight;
        if (!pricedFlight) {
          errors.push(`Trip[${tripIndex}].Leg[${si}]: missing Flight in GetSPricer response`);
          return;
        }
        // Trim GetSPricer's fields — some providers return e.g. FlightNo
        // with stray leading whitespace ("9005" vs " 9005"), which isn't a
        // genuine flight-identity mismatch.
        const pricedFlightNo = String(pricedFlight.FlightNo || '').trim();
        const pricedDepartureCode = String(pricedFlight.DepartureCode || '').trim();
        const pricedArrivalCode = String(pricedFlight.ArrivalCode || '').trim();
        const pricedDepartureTime = String(pricedFlight.DepartureTime || '').trim();

        // FlightNo is the flight-identity anchor: a different flight number means a genuinely
        // different flight was priced, which is a real mismatch (a defect), not an accepted change.
        if (selLeg.FlightNo !== pricedFlightNo) {
          errors.push(`Trip[${tripIndex}].Leg[${si}] FlightNo mismatch: availability="${selLeg.FlightNo}" vs GetSPricer="${pricedFlightNo}"`);
        }

        // On the SAME flight, an airport/terminal or schedule (time) difference between search and
        // pricing is a legitimate mid-flow CHANGE — the priced itinerary is authoritative and we
        // accept it (policy: accept & continue). Record it as a warning so the change is visible,
        // but do not fail: the traveller/agent proceeds on the changed itinerary, as on the portal.
        else {
          if (selLeg.DepartureCode !== pricedDepartureCode || selLeg.ArrivalCode !== pricedArrivalCode) {
            warnings.push(`CHANGE: airport change on Trip[${tripIndex}].Leg[${si}] ${pricedFlightNo} — ` +
              `${selLeg.DepartureCode}→${selLeg.ArrivalCode} (searched) now ${pricedDepartureCode}→${pricedArrivalCode} (priced); accepted`);
          }
          if (selLeg.DepartureTime !== pricedDepartureTime) {
            warnings.push(`CHANGE: schedule change on Trip[${tripIndex}].Leg[${si}] ${pricedFlightNo} — ` +
              `departs ${selLeg.DepartureTime} (searched) now ${pricedDepartureTime} (priced); accepted`);
          }
        }
      });
    };

    // Domestic multicity's per-leg flow (5.GetSPricer_Leg{N}) prices one leg
    // per call — each step carries _legIndex, and the matching selection is
    // saved under SelectedJourneyKey_{legIndex} rather than the RT-style
    // SelectedJourneyKey/ReturnSelectedJourneyKey pair.
    if (step._legIndex !== undefined) {
      checkTrip(0, context[`SelectedJourneyKey_${step._legIndex}`]);
    } else {
      checkTrip(0, context.SelectedJourneyKey);
      if (data.Trips.length > 1 && context.ReturnSelectedJourneyKey) {
        checkTrip(1, context.ReturnSelectedJourneyKey);
      }
    }

    if (errors.length > 0) return this.fail(...errors);
    if (warnings.length > 0) return this.warn(...warnings);
    return this.pass();
  }
}

module.exports = new FlightMatchValidator();
