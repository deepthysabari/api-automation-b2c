'use strict';

const airlineResolver = require('../../engine/airlineResolver');

/**
 * BaseAirlineAdapter — Abstract base class for all airline adapters.
 * Every airline plugin (e.g. 6E, SG, AI) must extend this class and
 * implement all abstract methods.
 */
class BaseAirlineAdapter {
  constructor(config) {
    if (!config || !config.iataCode) {
      throw new Error('BaseAirlineAdapter requires a config object with iataCode');
    }
    this.config = config;
    this.iataCode = config.iataCode;
    this.name = config.name;
  }

  /**
   * Helper to load request body template JSON.
   *
   * B2C has no per-carrier template folders (unlike B2B's templates/<CODE>/ + a 6E stub
   * fallback) — every carrier shares the flat templates/*.json built from real live-verified
   * payloads in Phase 1. A carrier-specific override folder is still honoured if one is ever
   * added (templates/<CODE>/<name>.json), same onboarding path as B2B.
   */
  loadTemplate(templateName, variables = {}) {
    const fs = require('fs');
    const path = require('path');
    let templatePath = path.join(__dirname, `../../templates/${this.iataCode}`, `${templateName}.json`);
    if (!fs.existsSync(templatePath)) {
      templatePath = path.join(__dirname, '../../templates', `${templateName}.json`);
    }
    let content = fs.readFileSync(templatePath, 'utf8');
    
    // Replace compile-time placeholders like <<variable>>
    for (const [key, value] of Object.entries(variables)) {
      if (typeof value === 'object') {
        content = content.replace(new RegExp(`"<<${key}>>"`, 'g'), JSON.stringify(value));
      } else if (typeof value === 'boolean' || typeof value === 'number') {
        content = content.replace(new RegExp(`"<<${key}>>"`, 'g'), value);
        content = content.replace(new RegExp(`<<${key}>>`, 'g'), value);
      } else {
        content = content.replace(new RegExp(`<<${key}>>`, 'g'), value);
      }
    }
    return JSON.parse(content);
  }

  /**
   * Returns the authentication request payload for this airline.
   * Called as the first step of every booking flow.
   * @returns {Object} Credential body
   */
  getAuthPayload() {
    return this.loadTemplate('signature_request');
  }

  /**
   * Returns base URL map for this airline.
   *
   * B2C splits ExpressSearch onto its own subdomain (AvlURLTest), separate from the rest of
   * the Flight API (FlightURLTest) — confirmed live in Phase 1. `avlUrl` falls back to
   * `flightUrl` when a carrier config has no avlUrlEnvKey, so this stays backward-compatible
   * with any config that predates the split.
   * @returns {{ authUrl: string, flightUrl: string, avlUrl: string }}
   */
  getBaseUrls() {
    const flightUrl = process.env[this.config.flightUrlEnvKey] || '';
    return {
      authUrl: process.env[this.config.authUrlEnvKey] || '',
      flightUrl,
      avlUrl: (this.config.avlUrlEnvKey && process.env[this.config.avlUrlEnvKey]) || flightUrl
    };
  }

  /**
   * Returns names of airline-specific validators to run.
   * These are in addition to the global validators declared in the scenario.
   * @returns {string[]}
   */
  getAirlineValidators() {
    return [];
  }

  /**
   * Optionally normalize a step's response to a standard shape.
   * Useful when different airlines return the same data in different keys.
   * @param {string} stepName
   * @param {Object} responseData
   * @returns {Object} normalized responseData
   */
  normalizeResponse(stepName, responseData) {
    return responseData; // default: pass-through
  }

  /**
   * Build the trips array from scenario dimensions and dataset.
   * Shared helper for OW / RT / MC trip types.
   * @param {Object} scenario
   * @returns {Array}
   */
  buildTrips(scenario) {
    const { tripType } = scenario.dimensions;
    const { origin, destination, onwardDate, returnDate, sectors } = scenario.dataset;
    // Cabin class does NOT travel per-trip as OnwardCabin/ReturnCabin for B2C — despite a prior
    // comment here claiming the opposite (ported from B2B, never actually re-verified for B2C).
    // Confirmed live 2026-09-22, from a real request the user captured directly against the beta
    // API: sending Cabin only in the top-level `Cabin` field (Trips[] carrying no cabin fields at
    // all) returns genuinely cabin-filtered results — e.g. Cabin:"B" on COK-BOM returned 140
    // journeys, EVERY one Cabin:"B". The reverse (OnwardCabin per-trip, top-level Cabin empty —
    // this project's own prior behavior) returned only Economy regardless of what was requested.
    // See docs/changes/2026-09-22-cabin-class-top-level-field.md. Trips[] carries no cabin field
    // at all now; the top-level `Cabin` field is set once per ExpressSearch body instead (see
    // every call site below).
    if (tripType === 'OW') {
      return [{ From: origin, To: destination, OnwardDate: onwardDate, ReturnDate: null, TUI: '' }];
    }
    if (tripType === 'RT') {
      return [
        { From: origin, To: destination, OnwardDate: onwardDate, ReturnDate: returnDate, TUI: '' }
      ];
    }
    if (tripType === 'MC' && Array.isArray(sectors)) {
      return sectors.map(s => ({ From: s.origin, To: s.destination, OnwardDate: s.date, ReturnDate: null, TUI: '' }));
    }
    throw new Error(`[${this.iataCode}] Unknown tripType: ${tripType}`);
  }

  /**
   * Returns a human-readable summary for logging.
   * @param {Object} scenario
   * @returns {string}
   */
  describeScenario(scenario) {
    const { sectorType, tripType, passengerMix } = scenario.dimensions;
    const pax = `${passengerMix.ADT}ADT_${passengerMix.CHD}CHD_${passengerMix.INF}INF`;
    return `[${this.iataCode}] ${sectorType} ${tripType} ${pax}`;
  }

  /**
   * Generates a dynamic Travellers list based on passengerMix.
   * Calculates DOB strings dynamically based on age and active year.
   * @param {Object} passengerMix
   * @returns {Array<Object>}
   */
  buildTravellers(passengerMix) {
    const travellers = [];
    let id = 1;

    const getDOBForAge = (age) => {
      const date = new Date();
      date.setFullYear(date.getFullYear() - age);
      const yyyy = date.getFullYear();
      const mm = String(date.getMonth() + 1).padStart(2, '0');
      const dd = String(date.getDate()).padStart(2, '0');
      return `${yyyy}-${mm}-${dd}`;
    };

    const getFutureExpiryDate = () => {
      const date = new Date();
      date.setFullYear(date.getFullYear() + 10);
      const yyyy = date.getFullYear();
      const mm = String(date.getMonth() + 1).padStart(2, '0');
      const dd = String(date.getDate()).padStart(2, '0');
      return `${yyyy}-${mm}-${dd}`;
    };

    const getRandomAlpha = (length = 2) => {
      let res = '';
      for (let k = 0; k < length; k++) {
        res += String.fromCharCode(65 + Math.floor(Math.random() * 26));
      }
      return res;
    };

    const pdoe = getFutureExpiryDate();

    // 1. Adults
    const adtCount = passengerMix.ADT || 0;
    for (let i = 0; i < adtCount; i++) {
      const suffix = getRandomAlpha(2);
      travellers.push({
        ID: id++,
        Title: 'Mr',
        FName: `TESTADT${String.fromCharCode(65 + i)}${suffix}`,
        LName: 'TESTAB',
        Age: 33,
        DOB: getDOBForAge(33),
        Gender: 'M',
        PTC: 'ADT',
        Nationality: 'IN',
        PassportNo: `PASSPORTA${id}`,
        PLI: 'Cochin',
        PDOE: pdoe,
        VisaType: 'Visiting Visa'
      });
    }

    // 2. Children
    const chdCount = passengerMix.CHD || 0;
    for (let i = 0; i < chdCount; i++) {
      const suffix = getRandomAlpha(2);
      travellers.push({
        ID: id++,
        Title: 'Miss',
        FName: `TESTCHD${String.fromCharCode(65 + i)}${suffix}`,
        LName: 'TESTAB',
        Age: 8,
        DOB: getDOBForAge(8),
        Gender: 'F',
        PTC: 'CHD',
        Nationality: 'IN',
        PassportNo: `PASSPORTC${id}`,
        PLI: 'Cochin',
        PDOE: pdoe,
        VisaType: 'Visiting Visa'
      });
    }

    // 3. Infants
    const infCount = passengerMix.INF || 0;
    for (let i = 0; i < infCount; i++) {
      const suffix = getRandomAlpha(2);
      travellers.push({
        ID: id++,
        Title: 'Mstr',
        FName: `TESTINF${String.fromCharCode(65 + i)}${suffix}`,
        LName: 'TESTAB',
        Age: 1,
        DOB: getDOBForAge(1),
        Gender: 'M',
        PTC: 'INF',
        Nationality: 'IN',
        PassportNo: `PASSPORTI${id}`,
        PLI: 'Cochin',
        PDOE: pdoe,
        VisaType: 'Visiting Visa'
      });
    }

    return travellers;
  }

  /**
   * Resolves fare product selection codes.
   * Can be overridden by child class adapters.
   */
  _getFCTypeSelector(scenario) {
    const fcType = scenario.fcType || (scenario.dimensions && scenario.dimensions.fcType);
    const cabinClass = scenario.dimensions && scenario.dimensions.cabinClass;

    if (fcType) {
      const mapping = {
        "Saver": "SAVER",
        "Sale": "SALE",
        "FlexiPlus Fare": "FLEXI",
        "Indigo Upfront": "INDIGO",
        "Tactical Fare": "TACTICAL",
        "Family Fare": "FAMILY",
        "Senior Citizen Fare": "SENIOR",
        "Stretch": "STRETCH -",
        "Stretch Plus": "STRETCH+"
      };
      return mapping[fcType] || fcType.toUpperCase();
    }

    if (cabinClass === 'BC' || cabinClass === 'Stretch Plus') {
      return 'STRETCH+';
    }
    if (cabinClass === 'BR' || cabinClass === 'Stretch') {
      return 'STRETCH -';
    }
    if (cabinClass === 'B') {
      return 'STRETCH';
    }
    return 'SAVER';
  }

  /**
   * Generates the step sequence for this airline.
   */
  getFlowSteps(scenario) {
    const steps = this._buildFlowSteps(scenario);

    // Tag every getSearch step with the carrier a "preferred" scenario actually cares about,
    // so engine/executor.js's date-retry can check for THAT carrier's own journeys rather than
    // total journey count. B2C's ExpressSearch never filters by carrier (see the
    // preferedAirlines/baseAirlineCode note below), so a niche/low-frequency carrier's sector
    // (e.g. Star Air's BLR-PNQ) always has hundreds of OTHER carriers' journeys even on a day
    // it has none itself — "total journeys === 0" can never trigger for it, silently defeating
    // the whole point of the retry. Confirmed live: BLR-PNQ genuinely has zero S5 journeys on
    // some dates and 1-2 on others, while always carrying 300+ AI/6E/IX/QP journeys regardless.
    const searchMode = airlineResolver.resolveSearchMode(scenario);
    const expectedAirline = (searchMode === 'preferred' && scenario.dimensions?.airline)
      ? airlineResolver.baseCarrier(scenario.dimensions.airline)
      : null;
    if (expectedAirline) {
      steps.forEach(s => { if (s._stepKey === 'getSearch') s._expectedAirline = expectedAirline; });
    }

    return steps;
  }

  /** @private — see getFlowSteps() for the public entry point and post-processing. */
  _buildFlowSteps(scenario) {
    const { passengerMix, cabinClass, tripType, sectorType, fareProduct } = scenario.dimensions;
    let akbarTripType = tripType === 'OW' ? 'ON' : tripType; // OW -> ON, RT -> RT, MC -> MC
    if (tripType === 'MC') {
      akbarTripType = sectorType === 'INT' ? 'IM' : 'DM';
    }
    // A round trip has two fare products, and the wire distinguishes them by FareType alone —
    // the rest of the ExpressSearch body is identical.
    //   RT  normal fare      — legs priced independently, combine freely across airlines.
    //   RS  Return Special   — provider returns pre-combined onward+return packages, priced
    //                          as one unit and paired by Provider + ReturnIdentifier.
    // The portal fires both for every round trip; a scenario picks one via the fareProduct
    // dimension ("And fare product is \"RS\"").
    if (tripType === 'RT' && String(fareProduct || '').toUpperCase() === 'RS') {
      akbarTripType = 'RS';
    }
    const expressSearchFareType = akbarTripType;
    const { authUrl, flightUrl, avlUrl } = this.getBaseUrls();
    const trips = this.buildTrips(scenario);
    const fcTypeSelector = this._getFCTypeSelector(scenario);

    const searchMode = airlineResolver.resolveSearchMode(scenario);
    // B2C's ExpressSearch does NOT actually filter by airline, unlike B2B — confirmed live:
    // sending Parameters.Airlines:"9I" + preferedAirlines:[{Code:"9I",...}] on COK-BLR still
    // returned 213 journeys, only 3 genuinely 9I and 210 AI (2026-09-21). The filter fields are
    // accepted by the API but have no real effect; every B2C ExpressSearch is a marketplace
    // search regardless of what's sent here. Never send a carrier filter — a scenario that wants
    // to confirm one carrier's availability must inspect the (always-unfiltered) response
    // instead (see validators/availability/availabilityValidator.js's preferred-mode handling),
    // and route selection to a sector that carrier actually flies is handled separately by
    // engine/sectorResolutionEngine.js, independent of this. This is a platform-wide B2C/B2B
    // difference, not a carrier quirk, so it's fixed here rather than per-adapter.
    const preferedAirlines = [];
    const baseAirlineCode = '';

    // Domestic multicity has its own dedicated per-leg flow (below) that returns early, so any MC
    // trip reaching the shared flow further down is INTERNATIONAL MC — a combined itinerary, which
    // is priced very differently from a round trip. Verified live on the production portal.
    const isIntlMC = tripType === 'MC';
    const sectorCount = (Array.isArray(scenario.dataset?.sectors) && scenario.dataset.sectors.length)
      ? scenario.dataset.sectors.length
      : (Array.isArray(trips) ? trips.length : 1);

    // Trips array for SmartPricer / SSR / FareRule, by fare product:
    //   OW      — 1 Trip.
    //   RT      — 2 Trips: onward + an independently-priced return (a DIFFERENT Index).
    //   INT MC  — N Trips (one per sector), ALL referencing Trips[0]'s combination Index, with the
    //             total fare on the first Trip and 0 on the rest. Confirmed on the portal:
    //             SmartPricer for BOM-DXB-SIN-BKK sent 3 Trips, every Index "1GN|1", Amounts
    //             [132611, 0, 0], TripType IM. It rejects an independent return leg (the RT shape)
    //             with Code 501 "No Data Found", which is what broke international MC pricing.
    const buildPricedTrips = (extraFields = {}, returnExtraFields = extraFields) => {
      if (isIntlMC) {
        return Array.from({ length: sectorCount }, (_, i) => ({
          Amount: i === 0 ? '{{Amount}}' : 0,
          Index: '{{Index}}',
          OrderID: i + 1,
          TUI: '{{SearchTUI}}',
          ...extraFields
        }));
      }
      if (tripType === 'RT') {
        return [
          { Amount: '{{Amount}}', Index: '{{Index}}', OrderID: 1, TUI: '{{SearchTUI}}', ...extraFields },
          { Amount: '{{ReturnAmount}}', Index: '{{ReturnIndex}}', OrderID: 2, TUI: '{{SearchTUI}}', ...returnExtraFields }
        ];
      }
      return [{ Amount: '{{Amount}}', Index: '{{Index}}', OrderID: 1, TUI: '{{SearchTUI}}', ...extraFields }];
    };

    // SmartPricer must echo back the SELECTED journey's OWN ChannelCode/WPRegionCode — these
    // used to be hardcoded to null/''. A search can return WP-channel journeys alongside the
    // ordinary ones (verified live 2026-09-15, SV BOM-JED: one GetExpSearch poll carried the
    // ordinary GDS/NDC rows "1G|1|C"/"SB|1|C" with ChannelCode "", a later poll carried
    // WP rows "SB|100001".."SB|100004" with ChannelCode "WP", WPRegionCode "AE"), and the
    // FCType selector can legitimately land on a WP row. Pricing a WP row with ChannelCode
    // null is rejected by SmartPricer with Code 1601 "No Record found" every single time,
    // while the same Index sent with the journey's own "WP"/"AE" returns Code 200 and prices
    // through to GetSPricer 200. Non-WP journeys report ChannelCode ""/null and
    // WPRegionCode "" — exactly what the old hardcode sent — so echoing changes nothing for
    // them (re-verified live on 6E domestic and on SV's ordinary 1G/SB/AM rows).
    const smartPricerTrips = buildPricedTrips(
      { ChannelCode: '{{ChannelCode}}', WPRegionCode: '{{WPRegionCode}}' },
      { ChannelCode: '{{ReturnChannelCode}}', WPRegionCode: '{{ReturnWPRegionCode}}' }
    );
    const ssrFareRuleTrips = buildPricedTrips();

    // getSearch save block. Only a round trip captures a separate return leg; OW and INT MC do not
    // — an INT MC's legs all share the one combination Index already held in {{Index}}.
    const searchSave = (tripType === 'RT') ? {
      SearchTUI: 'response.data.TUI',
      Amount: `response.data.Trips[0].Journey[FCType="${fcTypeSelector}"].NetFare`,
      Index: `response.data.Trips[0].Journey[FCType="${fcTypeSelector}"].Index`,
      OrderID: `response.data.Trips[0].Journey[FCType="${fcTypeSelector}"].OrderID`,
      SelectedJourneyKey: `response.data.Trips[0].Journey[FCType="${fcTypeSelector}"].JourneyKey`,
      // Carried into SmartPricer's Trips — see smartPricerTrips above for why the selected
      // journey's own channel/region must be echoed back rather than hardcoded.
      ChannelCode: `response.data.Trips[0].Journey[FCType="${fcTypeSelector}"].ChannelCode`,
      WPRegionCode: `response.data.Trips[0].Journey[FCType="${fcTypeSelector}"].WPRegionCode`,
      ReturnAmount: `response.data.Trips[1].Journey[FCType="${fcTypeSelector}"].NetFare`,
      ReturnIndex: `response.data.Trips[1].Journey[FCType="${fcTypeSelector}"].Index`,
      ReturnOrderID: `response.data.Trips[1].Journey[FCType="${fcTypeSelector}"].OrderID`,
      ReturnSelectedJourneyKey: `response.data.Trips[1].Journey[FCType="${fcTypeSelector}"].JourneyKey`,
      ReturnChannelCode: `response.data.Trips[1].Journey[FCType="${fcTypeSelector}"].ChannelCode`,
      ReturnWPRegionCode: `response.data.Trips[1].Journey[FCType="${fcTypeSelector}"].WPRegionCode`
    } : {
      SearchTUI: 'response.data.TUI',
      Amount: `response.data.Trips[0].Journey[FCType="${fcTypeSelector}"].NetFare`,
      Index: `response.data.Trips[0].Journey[FCType="${fcTypeSelector}"].Index`,
      OrderID: `response.data.Trips[0].Journey[FCType="${fcTypeSelector}"].OrderID`,
      SelectedJourneyKey: `response.data.Trips[0].Journey[FCType="${fcTypeSelector}"].JourneyKey`,
      ChannelCode: `response.data.Trips[0].Journey[FCType="${fcTypeSelector}"].ChannelCode`,
      WPRegionCode: `response.data.Trips[0].Journey[FCType="${fcTypeSelector}"].WPRegionCode`
    };

    // SSR purchase mode: FREE returns the fare's included baggage allowance (Charge 0),
    // PAID returns purchasable extra-baggage options (Charge > 0) — only airlines
    // registered with supportsPaidSSR in configs/airlines.json can be asked for it.
    // NOTE: distinct from scenario.ssrType (matrixGenerator's NONE/MEAL/SEAT/BAGGAGE
    // SSR-category dimension) — this is which flavor of the SSR *call* to make.
    const ssrPurchaseType = (scenario.dimensions?.ssrPurchaseType || 'FREE').toString().toUpperCase();
    if (ssrPurchaseType !== 'FREE' && ssrPurchaseType !== 'PAID') {
      throw new Error(`[${this.iataCode}] Invalid ssrPurchaseType dimension: ${ssrPurchaseType} (expected FREE or PAID)`);
    }
    if (ssrPurchaseType === 'PAID') {
      const airlineMeta = airlineResolver.getAirline(this.iataCode);
      if (!airlineMeta || !airlineMeta.supportsPaidSSR) {
        throw new Error(`[${this.iataCode}] Paid SSR requested but this airline does not support paid SSR (supportsPaidSSR is false/unset in configs/airlines.json)`);
      }
    }
    const paidSSR = ssrPurchaseType === 'PAID';

    // Free SSR is requested pre-pricing (availability page, ExpressSearch TUI); paid SSR is
    // requested post-pricing (GetSPricer TUI). FareRule keeps using ssrFareRuleTrips unmodified
    // (pre-pricing TUI) regardless of paidSSR — only the SSR step's own Trips need the override.
    //
    // Amount/Index are blanked (0 / ""), NOT the real priced values SmartPricer/FareRule use.
    // Verified live by isolating each field one at a time: /Flights/SSR looks the session up by
    // TUI alone — sending the real Amount/Index (which FareRule/CreateItinerary DO need) makes
    // this endpoint specifically fail with Code 1025 "Unable to Fetch Store Response", on every
    // single call, regardless of Source/ClientID/FareType. Blanking them is what a captured
    // working request does, and reproducing it exactly (same TUI/ClientID session) confirmed it.
    const ssrTrips = ssrFareRuleTrips.map(t => ({
      ...t,
      TUI: paidSSR ? '{{PricedTUI}}' : '{{SearchTUI}}',
      Amount: 0,
      Index: ''
    }));

    // Availability-only search flow
    if (scenario.flow === 'availabilityOnlyFlow') {
      if (tripType === 'MC' && sectorType === 'DOM') {
        const sectors = scenario.dataset.sectors || [];
        const steps = [
          {
            name: '1.Signature',
            _stepKey: 'auth',
            request: {
              method: 'POST',
              url: `${authUrl}/Utils/Signature`,
              headers: { 'Content-Type': 'application/json' },
              body: this.getAuthPayload()
            },
            save: {
              Token: 'response.data.Token',
              SearchTUI: 'response.data.TUI',
              ClientID: 'response.data.ClientID'
            },
            validations: { status: 200 },
            _validators: ['business']
          }
        ];

        sectors.forEach((sec, i) => {
          const legNum = i + 1;
          const tripPayload = [{
            From: sec.origin,
            To: sec.destination,
            OnwardDate: sec.date,
            ReturnDate: '',
            TUI: '',
            FromCity: '',
            FromArptName: '',
            ToCity: '',
            ToArptName: ''
          }];

          steps.push(
            {
              name: `2.ExpressSearch_Leg${legNum}`,
              _stepKey: 'search',
              _legIndex: i,
              request: {
                method: 'POST',
                url: `${avlUrl}/flights/ExpressSearch`,
                headers: { 'Content-Type': 'application/json' },
                body: {
                  ADT: passengerMix.ADT,
                  CHD: passengerMix.CHD,
                  INF: passengerMix.INF,
                  // Cabin class travels as the top-level Cabin field, not per-trip — see
                  // buildTrips()'s comment for the live evidence.
                  Cabin: cabinClass || this.config.defaultCabinClass,
                  Source: this.config.source,
                  Mode: this.config.mode,
                  ClientID: '{{ClientID}}',
                  // Domestic multicity is N INDEPENDENT one-way searches: every leg's
                  // ExpressSearch is a cold search that sends TUI:"" and mints its own fresh
                  // TUI in the response, which feeds only that same leg's GetExpSearch poll.
                  // Verified against a live portal capture of a domestic MC ExpressSearch
                  // ("TUI":"" on every leg). There is NO cross-leg TUI relay — an earlier
                  // version chained leg N's TUI from leg N-1's GetExpSearch, which was wrong
                  // and made the legs artificially dependent. See
                  // docs/changes/2026-07-31-domestic-mc-expresssearch-tui-independence.md
                  TUI: '',
                  FareType: 'DM',
                  Trips: tripPayload,
                  preferedAirlines: preferedAirlines,
                  Parameters: {
                    Airlines: baseAirlineCode,
                    GroupType: 'FULL',
                    Refundable: '',
                    IsDirect: scenario.dimensions.isDirect === true,
                    IsNearbyAirport: scenario.dimensions.isNearbyAirport === true,
                    IsGDSSearch: true,
                    IsLCCSearch: true,
                    IsNDCSearch: false,
                    // Fare-category eligibility (senior citizen, student, ...) is NOT the
                    // IsSeniorCitizen/IsStudentFare booleans this used to send — confirmed live
                    // 2026-09-23 to have zero effect (identical results with/without). The real
                    // mechanism, captured directly from a live request by the user:
                    // Parameters.PaxCategory, e.g. "SCP" for senior citizen — genuinely returns
                    // journeys tagged PaxCategory:"SCP". See
                    // docs/changes/2026-09-23-fare-category-paxcategory-fix.md.
                    PaxCategory: scenario.dimensions.paxCategory || ''
                  }
                }
              },
              save: {
                [`SearchTUI_${i}`]: 'response.data.TUI'
              },
              validations: { status: 200 },
              _validators: ['business']
            },
            {
              name: `3.GetExpSearch_Leg${legNum}`,
              _stepKey: 'getSearch',
              _legIndex: i,
              request: {
                method: 'POST',
                url: `${flightUrl}/flights/GetExpSearch`,
                headers: { 'Content-Type': 'application/json' },
                body: {
                  ClientID: '{{ClientID}}',
                  TUI: `{{SearchTUI_${i}}}`
                }
              },
              save: {
                [`SearchTUI_${i}`]: 'response.data.TUI'
              },
              validations: { status: 200 },
              _validators: ['business', 'availability']
            }
          );
        });

        return steps;
      }

      // Standard 3-step search flow for OneWay, RoundTrip, and International Multicity
      return [
        {
          name: '1.Signature',
          _stepKey: 'auth',
          request: {
            method: 'POST',
            url: `${authUrl}/Utils/Signature`,
            headers: { 'Content-Type': 'application/json' },
            body: this.getAuthPayload()
          },
          save: {
            Token: 'response.data.Token',
            SearchTUI: 'response.data.TUI',
            ClientID: 'response.data.ClientID'
          },
          validations: { status: 200 },
          _validators: ['business']
        },
        {
          name: '2.ExpressSearch',
          _stepKey: 'search',
          request: {
            method: 'POST',
            url: `${avlUrl}/flights/ExpressSearch`,
            headers: { 'Content-Type': 'application/json' },
            body: this.loadTemplate('express_search_request', {
              'pax.ADT': passengerMix.ADT,
              'pax.CHD': passengerMix.CHD,
              'pax.INF': passengerMix.INF,
              'cabin': cabinClass || this.config.defaultCabinClass,
              'source': this.config.source,
              'mode': this.config.mode,
              'akbarTripType': akbarTripType,
              'trips': trips,
              'preferedAirlines': preferedAirlines,
              'airlineCode': baseAirlineCode,
              'isDirect': scenario.dimensions.isDirect === true,
              'isNearbyAirport': scenario.dimensions.isNearbyAirport === true,
              // Fare-category eligibility (senior citizen, student, ...) is NOT the
              // IsSeniorCitizen/IsStudentFare booleans this template used to carry a hardcoded
              // "" for either way — confirmed live 2026-09-23 to have zero effect. The real
              // mechanism is Parameters.PaxCategory (e.g. "SCP" for senior citizen — genuinely
              // returns journeys tagged PaxCategory:"SCP"). See
              // docs/changes/2026-09-23-fare-category-paxcategory-fix.md.
              'paxCategory': scenario.dimensions.paxCategory || ''
            })
          },
          save: {
            SearchTUI: 'response.data.TUI'
          },
          validations: { status: 200 },
          _validators: ['business']
        },
        {
          name: '3.GetExpSearch',
          _stepKey: 'getSearch',
          request: {
            method: 'POST',
            url: `${flightUrl}/flights/GetExpSearch`,
            headers: { 'Content-Type': 'application/json' },
            body: {
              ClientID: '{{ClientID}}',
              TUI: '{{SearchTUI}}'
            }
          },
          save: {
            SearchTUI: 'response.data.TUI'
          },
          validations: { status: 200 },
          _validators: ['business', 'availability']
        }
      ];
    }

    // Dynamic domestic multicity booking flow
    if (tripType === 'MC' && sectorType === 'DOM') {
      const sectors = scenario.dataset.sectors || [];
      const steps = [
        {
          name: '1.Signature',
          _stepKey: 'auth',
          request: {
            method: 'POST',
            url: `${authUrl}/Utils/Signature`,
            headers: { 'Content-Type': 'application/json' },
            body: this.getAuthPayload()
          },
          save: {
            Token: 'response.data.Token',
            SearchTUI: 'response.data.TUI',
            ClientID: 'response.data.ClientID'
          },
          validations: { status: 200 },
          _validators: ['business']
        }
      ];

      // Two passes, not one interleaved loop: the search phase (ExpressSearch+GetExpSearch)
      // for every leg comes first, then every leg's pricing/SSR/booking phase.
      //
      // The search phase has NO cross-leg dependency at all: each leg is an independent
      // one-way cold search (TUI:"", own SearchTUI_${i}, own validators). runner.js
      // therefore dispatches the legs' search pairs CONCURRENTLY and fault-isolated — a
      // failure on one leg's GetExpSearch no longer prevents its siblings from running and
      // being reported. (It keys off _legIndex + _stepKey search/getSearch; see runner.js.)
      //
      // The pricing/SSR/booking phase stays strictly sequential and leg-ordered: only
      // CreateItinerary_Leg{n>1} has a real cross-leg dependency (RefTransactionID from
      // CreateItinerary_Leg1 — the multi-leg itinerary is one transaction).
      sectors.forEach((sec, i) => {
        const legNum = i + 1;
        const tripPayload = [{
          From: sec.origin,
          To: sec.destination,
          OnwardDate: sec.date,
          ReturnDate: '',
          TUI: '',
          FromCity: '',
          FromArptName: '',
          ToCity: '',
          ToArptName: ''
        }];

        steps.push(
          {
            name: `2.ExpressSearch_Leg${legNum}`,
            _stepKey: 'search',
            _legIndex: i,
            request: {
              method: 'POST',
              url: `${avlUrl}/flights/ExpressSearch`,
              headers: { 'Content-Type': 'application/json' },
              body: {
                ADT: passengerMix.ADT,
                CHD: passengerMix.CHD,
                INF: passengerMix.INF,
                // Cabin class travels as the top-level Cabin field, not per-trip — see
                // buildTrips()'s comment for the live evidence.
                Cabin: cabinClass || this.config.defaultCabinClass,
                Source: this.config.source,
                Mode: this.config.mode,
                ClientID: '{{ClientID}}',
                // Cold search per leg — see the availabilityOnlyFlow twin above and
                // docs/changes/2026-07-31-domestic-mc-expresssearch-tui-independence.md:
                // every domestic-MC leg sends TUI:"" and mints its own TUI.
                TUI: '',
                FareType: 'DM',
                Trips: tripPayload,
                preferedAirlines: preferedAirlines,
                Parameters: {
                  Airlines: baseAirlineCode,
                  GroupType: 'FULL',
                  Refundable: '',
                  IsDirect: scenario.dimensions.isDirect === true,
                  IsNearbyAirport: scenario.dimensions.isNearbyAirport === true,
                  IsGDSSearch: true,
                  IsLCCSearch: true,
                  IsNDCSearch: false,
                  // See buildTrips()'s comment for the live evidence on why this is
                  // PaxCategory, not IsSeniorCitizen/IsStudentFare.
                  PaxCategory: scenario.dimensions.paxCategory || ''
                }
              }
            },
            save: {
              [`SearchTUI_${i}`]: 'response.data.TUI'
            },
            validations: { status: 200 },
            _validators: ['business']
          },
          {
            name: `3.GetExpSearch_Leg${legNum}`,
            _stepKey: 'getSearch',
            _legIndex: i,
            request: {
              method: 'POST',
              url: `${flightUrl}/flights/GetExpSearch`,
              headers: { 'Content-Type': 'application/json' },
              body: {
                ClientID: '{{ClientID}}',
                TUI: `{{SearchTUI_${i}}}`
              }
            },
            save: {
              [`SearchTUI_${i}`]: 'response.data.TUI',
              [`Amount_${i}`]: `response.data.Trips[0].Journey[FCType="${fcTypeSelector}"].NetFare`,
              [`Index_${i}`]: `response.data.Trips[0].Journey[FCType="${fcTypeSelector}"].Index`,
              [`OrderID_${i}`]: `response.data.Trips[0].Journey[FCType="${fcTypeSelector}"].OrderID`,
              [`SelectedJourneyKey_${i}`]: `response.data.Trips[0].Journey[FCType="${fcTypeSelector}"].JourneyKey`,
              // Echoed back into this leg's SmartPricer — same reason as the shared flow's
              // smartPricerTrips (a WP-channel journey priced with a hardcoded null
              // ChannelCode is rejected with Code 1601 "No Record found").
              [`ChannelCode_${i}`]: `response.data.Trips[0].Journey[FCType="${fcTypeSelector}"].ChannelCode`,
              [`WPRegionCode_${i}`]: `response.data.Trips[0].Journey[FCType="${fcTypeSelector}"].WPRegionCode`
            },
            validations: { status: 200 },
            _validators: ['business', 'pricing', 'segment', 'passenger']
          }
        );
      });

      sectors.forEach((sec, i) => {
        const legNum = i + 1;

        steps.push(
          {
            name: `4.SmartPricer_Leg${legNum}`,
            _stepKey: 'price',
            _legIndex: i,
            request: {
              method: 'POST',
              url: `${flightUrl}/Flights/SmartPricer`,
              headers: { 'Content-Type': 'application/json' },
              body: {
                Trips: [
                  {
                    Amount: `{{Amount_${i}}}`,
                    Index: `{{Index_${i}}}`,
                    ChannelCode: `{{ChannelCode_${i}}}`,
                    WPRegionCode: `{{WPRegionCode_${i}}}`,
                    OrderID: legNum,
                    TUI: `{{SearchTUI_${i}}}`
                  }
                ],
                ClientID: '{{ClientID}}',
                Mode: 'SS',
                Options: 'A',
                Source: 'SF',
                TripType: 'DM'
              }
            },
            save: {
              [`PricedTUI_${i}`]: 'response.data.TUI'
            },
            validations: { status: 200 },
            _validators: ['business']
          },
          {
            name: `5.GetSPricer_Leg${legNum}`,
            _stepKey: 'getPrice',
            _legIndex: i,
            request: {
              method: 'POST',
              url: `${flightUrl}/Flights/GetSPricer`,
              headers: { 'Content-Type': 'application/json' },
              body: {
                TUI: `{{PricedTUI_${i}}}`,
                ClientID: '{{ClientID}}'
              }
            },
            save: {
              [`PricedTUI_${i}`]: 'response.data.TUI',
              [`FinalAmount_${i}`]: 'response.data.NetAmount',
              [`Trips_${i}`]: 'response.data.Trips',
              [`SSR_${i}`]: 'response.data.SSR',
              [`FareType_${i}`]: 'response.data.FareType',
              [`PricedSource_${i}`]: 'response.data.Source'
            },
            validations: { status: 200 },
            _validators: ['business', 'pricing', 'segment', 'passenger', ...this.getAirlineValidators()]
          },
          {
            name: `5.1.SSR_Leg${legNum}`,
            _stepKey: 'ssr',
            _legIndex: i,
            request: {
              method: 'POST',
              url: `${flightUrl}/Flights/SSR`,
              headers: { 'Content-Type': 'application/json' },
              body: {
                PaidSSR: paidSSR,
                ClientID: '{{ClientID}}',
                // Verified live on this endpoint: Source is stage-dependent, not a constant —
                // the pre-pricing (free) call only succeeds with "LV" (post-pricing "SF" here
                // returns Code 1000 "Failed"); the post-pricing (paid) call only succeeds with
                // "SF" ("LV" there returns Code 1025 "Unable to Fetch Store Response"). Mirrors
                // the TUI selection immediately below — same pre/post-pricing split.
                Source: paidSSR ? 'SF' : 'LV',
                FareType: `{{FareType_${i}}}`,
                Trips: [
                  {
                    Amount: `{{Amount_${i}}}`,
                    Index: `{{Index_${i}}}`,
                    OrderID: legNum,
                    // Free SSR is requested pre-pricing (availability page, ExpressSearch TUI);
                    // paid SSR is requested post-pricing (GetSPricer TUI).
                    TUI: paidSSR ? `{{PricedTUI_${i}}}` : `{{SearchTUI_${i}}}`
                  }
                ]
              }
            },
            validations: { status: 200 },
            _validators: ['ssrDetails']
          },
          {
            name: `5.2.FareRule_Leg${legNum}`,
            _stepKey: 'fareRule',
            _legIndex: i,
            request: {
              method: 'POST',
              url: `${flightUrl}/Flights/FareRule`,
              headers: { 'Content-Type': 'application/json' },
              body: {
                Trips: [
                  {
                    Amount: `{{Amount_${i}}}`,
                    Index: `{{Index_${i}}}`,
                    OrderID: legNum,
                    TUI: `{{SearchTUI_${i}}}`
                  }
                ],
                ClientID: '{{ClientID}}',
                Mode: this.config.mode,
                Options: '',
                Source: 'CF',
                TripType: 'DM'
              }
            },
            validations: { status: 200 }
          },
          {
            name: `6.CreateItinerary_Leg${legNum}`,
            _stepKey: 'createItinerary',
            _legIndex: i,
            request: {
              method: 'POST',
              url: `${flightUrl}/Flights/CreateItinerary`,
              headers: { 'Content-Type': 'application/json' },
              body: {
                TUI: `{{PricedTUI_${i}}}`,
                ContactInfo: {
                  Title: '',
                  FName: 'Test',
                  LName: 'Test',
                  Mobile: '9999999999',
                  Phone: '',
                  Email: 'mails@mail.com',
                  Address: 'test',
                  CountryCode: 'IN',
                  State: 'Kerala',
                  City: 'KOCHI',
                  PIN: '666666',
                  GSTCompanyName: '',
                  GSTTIN: '',
                  GSTMobile: '',
                  GSTEmail: '',
                  UpdateProfile: false,
                  IsGuest: false
                },
                Travellers: this.buildTravellers(passengerMix),
                PLP: [],
                // {{SelectedSSR_${i}}}/{{SelectedSSRAmount_${i}}} — this leg's own selection,
                // built by Executor._extractSelectedSSR from 5.1.SSR_Leg${legNum}'s response.
                // NOT {{SSR_${i}}} (GetSPricer's incompatible top-level SSR[] shape) — same fix
                // as the single-flow CreateItinerary step, applied here leg-indexed.
                SSR: `{{SelectedSSR_${i}}}`,
                Trips: `{{Trips_${i}}}`,
                FareType: `{{FareType_${i}}}`,
                Source: `{{PricedSource_${i}}}`,
                CrossSell: [],
                NetAmount: `{{FinalAmount_${i}}}`,
                SSRAmount: `{{SelectedSSRAmount_${i}}}`,
                ClientID: '{{ClientID}}',
                DeviceID: '',
                AppVersion: '',
                CrossSellAmount: 0,
                SequenceID: legNum,
                ...(i > 0 ? { RefTransactionID: '{{TransactionID}}' } : {})
              }
            },
            save: i === 0 ? {
              TransactionID: 'response.data.TransactionID',
              [`TransactionID_${i}`]: 'response.data.TransactionID',
              SearchTUI: 'response.data.TUI'
            } : {
              [`TransactionID_${i}`]: 'response.data.TransactionID',
              SearchTUI: 'response.data.TUI'
            },
            validations: { status: 200 },
            _validators: ['business']
          }
        );
      });

      if (scenario.flow === 'pricingOnlyFlow') {
        return steps.filter(s =>
          ['auth', 'search', 'getSearch', 'price', 'getPrice'].includes(s._stepKey)
        );
      }

      // fareRuleOnlyFlow: stop after FareRule — no CreateItinerary call (avoids creating a PNR).
      if (scenario.flow === 'fareRuleOnlyFlow') {
        return steps.filter(s =>
          ['auth', 'search', 'getSearch', 'price', 'getPrice', 'ssr', 'fareRule'].includes(s._stepKey)
        );
      }

      return steps;
    }

    // Standard booking flow (OneWay / RoundTrip / International Multicity)
    const bookingSteps = [
      {
        name: '1.Signature',
        _stepKey: 'auth',
        request: {
          method: 'POST',
          url: `${authUrl}/Utils/Signature`,
          headers: { 'Content-Type': 'application/json' },
          body: this.getAuthPayload()
        },
        save: {
          Token: 'response.data.Token',
          SearchTUI: 'response.data.TUI',
          ClientID: 'response.data.ClientID'
        },
        validations: { status: 200 },
        _validators: ['business']
      },
      {
        name: '2.ExpressSearch',
        _stepKey: 'search',
        request: {
          method: 'POST',
          url: `${avlUrl}/flights/ExpressSearch`,
          headers: { 'Content-Type': 'application/json' },
          body: {
            ADT: passengerMix.ADT,
            CHD: passengerMix.CHD,
            INF: passengerMix.INF,
            // Cabin class travels as the top-level Cabin field, not per-trip — see
            // buildTrips()'s comment for the live evidence.
            Cabin: cabinClass || this.config.defaultCabinClass,
            Source: this.config.source,
            Mode: this.config.mode,
            ClientID: '{{ClientID}}',
            TUI: '{{SearchTUI}}',
            FareType: expressSearchFareType,
            Trips: trips,
            preferedAirlines: preferedAirlines,
            Parameters: {
              Airlines: baseAirlineCode,
              GroupType: '',
              Refundable: '',
              IsDirect: scenario.dimensions.isDirect === true,
              IsNearbyAirport: scenario.dimensions.isNearbyAirport === true,
              // See buildTrips()'s comment for the live evidence on why this is
              // PaxCategory, not IsSeniorCitizen/IsStudentFare.
              PaxCategory: scenario.dimensions.paxCategory || '',
              IsExtendedSearch: false,
              IsGDSSearch: true,
              IsLCCSearch: true
            }
          }
        },
        save: {
          SearchTUI: 'response.data.TUI'
        },
        validations: { status: 200 },
        _validators: ['business']
      },
      {
        name: '3.GetExpSearch',
        _stepKey: 'getSearch',
        request: {
          method: 'POST',
          url: `${flightUrl}/flights/GetExpSearch`,
          headers: { 'Content-Type': 'application/json' },
          body: {
            ClientID: '{{ClientID}}',
            TUI: '{{SearchTUI}}'
          }
        },
        save: searchSave,
        validations: { status: 200 },
        _validators: ['business', 'pricing', 'segment', 'passenger']
      },
      {
        name: '4.SmartPricer',
        _stepKey: 'price',
        request: {
          method: 'POST',
          url: `${flightUrl}/Flights/SmartPricer`,
          headers: { 'Content-Type': 'application/json' },
          body: {
            Trips: smartPricerTrips,
            ClientID: '{{ClientID}}',
            Mode: 'SS',
            Options: 'A',
            Source: this.config.smartPricerSource,
            TripType: expressSearchFareType
          }
        },
        save: {
          PricedTUI: 'response.data.TUI'
        },
        validations: { status: 200 },
        _validators: ['business']
      },
      {
        name: '5.GetSPricer',
        _stepKey: 'getPrice',
        request: {
          method: 'POST',
          url: `${flightUrl}/Flights/GetSPricer`,
          headers: { 'Content-Type': 'application/json' },
          body: {
            TUI: '{{PricedTUI}}',
            ClientID: '{{ClientID}}'
          }
        },
        save: {
          PricedTUI: 'response.data.TUI',
          FinalAmount: 'response.data.NetAmount',
          Trips: 'response.data.Trips',
          SSR: 'response.data.SSR',
          FareType: 'response.data.FareType',
          PricedSource: 'response.data.Source',
          OrderID: 'response.data.Trips[0].Journey[0].OrderID',
          ReturnOrderID: 'response.data.Trips[1].Journey[0].OrderID'
        },
        validations: { status: 200 },
        _validators: ['business', 'pricing', 'segment', 'passenger', ...this.getAirlineValidators()]
      },
      {
        name: '5.1.SSR',
        _stepKey: 'ssr',
        request: {
          method: 'POST',
          url: `${flightUrl}/Flights/SSR`,
          headers: { 'Content-Type': 'application/json' },
          body: {
            PaidSSR: paidSSR,
            ClientID: '{{ClientID}}',
            // {{PricedSource}} (GetSPricer's own returned Source, e.g. "LV") — NOT a hardcoded
            // "CF". Verified live: a manually captured SSR call reusing this exact TUI/ClientID
            // with Source "LV" succeeded, while this step's hardcoded "CF" returned Code 1025
            // "Unable to Fetch Store Response" on every single call across the whole session —
            // the lookup is keyed by TUI+Source together, so the wrong Source can never find
            // the priced session's store.
            Source: '{{PricedSource}}',
            FareType: '{{FareType}}',
            Trips: ssrTrips
          }
        },
        validations: { status: 200 },
        _validators: ['ssrDetails']
      },
      {
        name: '5.2.FareRule',
        _stepKey: 'fareRule',
        request: {
          method: 'POST',
          url: `${flightUrl}/Flights/FareRule`,
          headers: { 'Content-Type': 'application/json' },
          body: {
            Trips: ssrFareRuleTrips,
            ClientID: '{{ClientID}}',
            Mode: this.config.mode,
            Options: '',
            Source: 'CF',
            TripType: akbarTripType
          }
        },
        validations: { status: 200 }
      },
      {
        name: '6.CreateItinerary',
        _stepKey: 'createItinerary',
        request: {
          method: 'POST',
          url: `${flightUrl}/Flights/CreateItinerary`,
          headers: { 'Content-Type': 'application/json' },
          body: {
            TUI: '{{PricedTUI}}',
            ContactInfo: {
              Title: '',
              FName: 'Test',
              LName: 'Test',
              Mobile: '9999999999',
              Phone: '',
              Email: 'mails@mail.com',
              Address: 'test',
              CountryCode: 'IN',
              State: 'Kerala',
              City: 'KOCHI',
              PIN: '666666',
              GSTCompanyName: '',
              GSTTIN: '',
              GSTMobile: '',
              GSTEmail: '',
              UpdateProfile: false,
              IsGuest: false
            },
            Travellers: this.buildTravellers(passengerMix),
            PLP: [],
            // {{SelectedSSR}}/{{SelectedSSRAmount}} — built by the executor from the
            // dedicated Flights/SSR response's per-segment SSR[] entries (Charge > 0
            // only), NOT GetSPricer's top-level SSR[] (different, incompatible shape).
            // See Executor._extractSelectedSSR. Verified against a live captured
            // CreateItinerary request/response pair.
            SSR: '{{SelectedSSR}}',
            Trips: '{{Trips}}',
            FareType: '{{FareType}}',
            Source: '{{PricedSource}}',
            CrossSell: [],
            NetAmount: '{{FinalAmount}}',
            SSRAmount: '{{SelectedSSRAmount}}',
            ClientID: '{{ClientID}}',
            DeviceID: '',
            AppVersion: '',
            CrossSellAmount: 0
          }
        },
        save: {
          TransactionID: 'response.data.TransactionID',
          SearchTUI: 'response.data.TUI'
        },
        validations: { status: 200 },
        _validators: ['business', 'itinerary']
      }
    ];

    // pricingOnlyFlow: stop after GetSPricer — no SSR/FareRule/CreateItinerary calls.
    if (scenario.flow === 'pricingOnlyFlow') {
      return bookingSteps.filter(s =>
        ['auth', 'search', 'getSearch', 'price', 'getPrice'].includes(s._stepKey)
      );
    }

    // fareRuleOnlyFlow: stop after FareRule — no CreateItinerary call (avoids creating a PNR).
    if (scenario.flow === 'fareRuleOnlyFlow') {
      return bookingSteps.filter(s =>
        ['auth', 'search', 'getSearch', 'price', 'getPrice', 'ssr', 'fareRule'].includes(s._stepKey)
      );
    }

    return bookingSteps;
  }
}

module.exports = BaseAirlineAdapter;
