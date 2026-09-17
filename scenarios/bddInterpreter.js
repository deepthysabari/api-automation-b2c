'use strict';

const fs = require('fs');
const path = require('path');

// Fail-fast validation of airline codes goes through airlineResolver, which owns the nested
// (LCC / GDS / NDC) shape of configs/airlines.json — a code counts as registered if it is in the
// LCC bucket or in any GDS/NDC provider's airlines[] list.
const airlineResolver = require('../engine/airlineResolver');

/**
 * BddInterpreter — A lightweight, robust, Gherkin-to-Scenario interpreter.
 * Parses Gherkin .feature syntax into standard execution scenarios.
 */
class BddInterpreter {
  /**
   * Parse a single Gherkin .feature file.
   * @param {string} filePath
   * @returns {Object[]} Executable scenarios
   */
  parseFile(filePath) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split(/\r?\n/);
    const scenarios = [];
    
    let currentFeatureName = 'BDD Feature';
    let currentScenario = null;
    let currentOutline = null;
    let inExamplesTable = false;
    // A tag block written directly above a `Scenario:`/`Scenario Outline:` line is processed
    // BEFORE that line — at that point `currentScenario`/`currentOutline` still refers to the
    // PREVIOUS block (or is null before the first one, or before any Scenario/Outline has
    // appeared yet). Routing straight into `currentScenario.tags.push(...)` at that moment
    // silently misattributed this scenario's own @priority/@retries override to the WRONG
    // scenario (or, for the very last scenario in a file, dropped it entirely — nothing ever
    // "closed" it to receive the mutation). This codebase's convention is always one tag block
    // immediately above its own Scenario/Outline (verified: no tag block anywhere precedes
    // `Feature:` or otherwise stands alone as a genuine file-wide broadcast), so EVERY tag
    // block — including the first one in a file — is buffered here and applied to whichever
    // Scenario/Outline is created next, below.
    let pendingCleanTags = [];
    let pendingPriority = null;
    let pendingRetries = null;

    lines.forEach((line, lineIndex) => {
      const lineNum = lineIndex + 1;
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;

      // 1. Parse Tags (e.g. @smoke @domestic @6E)
      if (trimmed.startsWith('@')) {
        const tags = trimmed.split(/\s+/).map(t => t.substring(1).trim()).filter(Boolean);
        const cleanTags = [];
        let priorityOverride = null;
        let retriesOverride = null;

        tags.forEach(t => {
          // Match @priority:N
          const priorityMatch = t.match(/^priority:(\d+)$/i);
          if (priorityMatch) {
            priorityOverride = parseInt(priorityMatch[1], 10);
            return;
          }
          // Match @retries:N
          const retriesMatch = t.match(/^retries:(\d+)$/i);
          if (retriesMatch) {
            retriesOverride = parseInt(retriesMatch[1], 10);
            return;
          }
          cleanTags.push(t);
        });

        pendingCleanTags.push(...cleanTags);
        if (priorityOverride !== null) pendingPriority = priorityOverride;
        if (retriesOverride !== null) pendingRetries = retriesOverride;
        return;
      }

      // 2. Parse Feature
      if (trimmed.startsWith('Feature:')) {
        currentFeatureName = trimmed.substring(8).trim();
        return;
      }

      // 3. Parse Scenario Outline
      if (trimmed.startsWith('Scenario Outline:')) {
        if (currentScenario) {
          scenarios.push(currentScenario);
          currentScenario = null;
        }
        if (currentOutline) {
          this._expandOutline(currentOutline, scenarios, filePath);
          currentOutline = null;
        }

        const outlineName = trimmed.substring(17).trim();
        currentOutline = {
          featureName: currentFeatureName,
          nameTemplate: outlineName,
          tags: [...pendingCleanTags, 'bdd', 'smoke'],
          priority: pendingPriority !== null ? pendingPriority : 1,
          steps: [],
          examplesHeaders: null,
          examplesRows: []
        };
        if (pendingRetries !== null) currentOutline.retries = pendingRetries;
        pendingCleanTags = [];
        pendingPriority = null;
        pendingRetries = null;
        inExamplesTable = false;
        return;
      }

      // 4. Parse Scenario
      if (trimmed.startsWith('Scenario:')) {
        if (currentScenario) {
          scenarios.push(currentScenario);
          currentScenario = null;
        }
        if (currentOutline) {
          this._expandOutline(currentOutline, scenarios, filePath);
          currentOutline = null;
        }

        const scenarioName = trimmed.substring(9).trim();
        const scenarioId = 'BDD_' + scenarioName.replace(/[^a-zA-Z0-9_]/g, '_').toUpperCase();

        currentScenario = {
          id: scenarioId,
          name: `${currentFeatureName} - ${scenarioName}`,
          tags: [...pendingCleanTags, 'bdd', 'smoke'],
          priority: pendingPriority !== null ? pendingPriority : 1,
          dimensions: {
            sectorType: 'DOM',
            tripType: 'OW',
            passengerMix: { ADT: 1, CHD: 0, INF: 0 },
            airline: '',
            cabinClass: 'E',
            fareProduct: 'RT',   // round-trip fare product: RT (normal) | RS (Return Special)
            searchMode: 'marketplace'
          },
          dataset: {
            sectorPool: 'domestic',
            selectionStrategy: 'RANDOM',
            onwardDate: '{{futureDate:3}}',
            returnDate: null
          },
          flow: 'availabilityOnlyFlow',
          validations: {
            validators: []
          }
        };
        if (pendingRetries !== null) currentScenario.retries = pendingRetries;
        pendingCleanTags = [];
        pendingPriority = null;
        pendingRetries = null;
        inExamplesTable = false;
        return;
      }

      // 5. Parse Examples Header
      if (trimmed.startsWith('Examples:')) {
        inExamplesTable = true;
        return;
      }

      // 6. Parse Examples rows
      if (trimmed.startsWith('|')) {
        if (inExamplesTable && currentOutline) {
          const cells = trimmed.split('|').map(c => c.trim()).filter((_, idx, arr) => idx > 0 && idx < arr.length - 1);
          if (!currentOutline.examplesHeaders) {
            currentOutline.examplesHeaders = cells;
          } else {
            currentOutline.examplesRows.push({ cells, lineNum });
          }
        }
        return;
      }

      // Steps (Given / When / Then / And)
      if (trimmed.startsWith('Given ') || trimmed.startsWith('When ') || trimmed.startsWith('Then ') || trimmed.startsWith('And ')) {
        if (currentScenario) {
          this._parseStepLine(trimmed, currentScenario, lineNum, filePath);
        } else if (currentOutline && !inExamplesTable) {
          currentOutline.steps.push({ text: trimmed, lineNum });
        }
      }
    });

    if (currentScenario) {
      scenarios.push(currentScenario);
    }
    if (currentOutline) {
      this._expandOutline(currentOutline, scenarios, filePath);
    }

    return scenarios;
  }

  /**
   * Helper to validate that an airline code is registered in configs/airlines.json.
   * @private
   */
  _validateAirline(airlineStr, lineNum, filePath) {
    if (!airlineStr) return;
    const codes = airlineStr.split(',').map(c => c.trim().toUpperCase()).filter(Boolean);
    codes.forEach(code => {
      if (!airlineResolver.getAirline(code)) {
        const baseName = path.basename(filePath || 'unknown.feature');
        throw new Error(`Airline '${code}' referenced in ${baseName} line ${lineNum} is not registered in configs/airlines.json`);
      }
    });
  }

  /**
   * Helper to parse a single Gherkin step string and modify the scenario target.
   * @private
   */
  _parseStepLine(trimmed, scenario, lineNum, filePath) {
    if (trimmed.startsWith('Given ') || trimmed.startsWith('And ') || trimmed.startsWith('When ') || trimmed.startsWith('Then ')) {
      // Find the keyword length to strip it
      let stepText = '';
      if (trimmed.startsWith('Given ')) stepText = trimmed.substring(6).trim();
      else if (trimmed.startsWith('When ')) stepText = trimmed.substring(5).trim();
      else if (trimmed.startsWith('Then ')) stepText = trimmed.substring(5).trim();
      else if (trimmed.startsWith('And ')) stepText = trimmed.substring(4).trim();

      // 1. Given user selects airline "6E"
      const airlineMatch = stepText.match(/user selects airline "([^"]+)"/);
      if (airlineMatch) {
        const code = airlineMatch[1].toUpperCase();
        this._validateAirline(code, lineNum, filePath);
        scenario.dimensions.airline = code;
        scenario.dimensions.searchMode = 'preferred';
        if (!scenario.tags.includes(code)) {
          scenario.tags.push(code);
        }
        return;
      }

      // 2. Given user searches all airlines
      if (stepText.match(/user searches.*all airlines/i)) {
        scenario.dimensions.searchMode = 'marketplace';
        return;
      }

      // 2.1. Given user enables direct flight filter
      if (stepText.match(/user enables direct flight filter/i)) {
        scenario.dimensions.isDirect = true;
        return;
      }

      // 2.2. Given user enables nearby airport search
      if (stepText.match(/user enables nearby airport search/i)) {
        scenario.dimensions.isNearbyAirport = true;
        return;
      }

      // 2.3. And student fare search is enabled
      if (stepText.match(/student fare search is enabled/i)) {
        scenario.dimensions.isStudentFare = true;
        return;
      }

      // 2.4. And senior citizen fare search is enabled
      if (stepText.match(/senior citizen fare search is enabled/i)) {
        scenario.dimensions.isSeniorCitizen = true;
        return;
      }

      // 2.5. And family fare search is enabled
      if (stepText.match(/family fare search is enabled/i)) {
        scenario.dimensions.isFamilyFare = true;
        return;
      }

      // 2.6. And retry with alternate dates if no availability
      //
      // Opt-in ONLY, for niche/low-frequency carriers that genuinely do not fly every day:
      // when the search completes with zero journeys, the engine re-issues the identical
      // search (same pax mix, cabin, carrier filter, route) on later dates before giving up
      // as SKIPPED — see engine/runner.js `_wireDateRetry` / engine/executor.js's getSearch
      // branch. Every scenario WITHOUT this step stays strictly date-deterministic.
      if (stepText.match(/retry with alternate dates? if no availability/i)) {
        scenario.dimensions.retryDatesOnEmptyInventory = true;
        return;
      }

      // 3. Given passenger mix is "2 ADT, 1 CHD"
      const paxMatch = stepText.match(/passenger mix is "([^"]+)"/i);
      if (paxMatch) {
        const mixStr = paxMatch[1];
        const mix = { ADT: 0, CHD: 0, INF: 0 };
        const parts = mixStr.split(',').map(p => p.trim());
        parts.forEach(part => {
          const match = part.match(/^(\d+)\s*([a-zA-Z]+)$/);
          if (match) {
            const count = parseInt(match[1], 10);
            const type = match[2].toUpperCase();
            if (type === 'ADT' || type === 'ADULT' || type === 'ADULTS') {
              mix.ADT = count;
            } else if (type === 'CHD' || type === 'CHILD' || type === 'CHILDREN') {
              mix.CHD = count;
            } else if (type === 'INF' || type === 'INFANT' || type === 'INFANTS') {
              mix.INF = count;
            }
          }
        });
        if (mix.ADT > 0 || mix.CHD > 0 || mix.INF > 0) {
          scenario.dimensions.passengerMix = mix;
        }
        return;
      }

      // 4. Given cabin class is "Business"
      const cabinMatch = stepText.match(/cabin class is "([^"]+)"/i);
      if (cabinMatch) {
        const cabinName = cabinMatch[1].trim();
        const mapping = {
          "Economy": "E",
          "Economy Class": "E",
          "Business": "B",
          "Business Class": "B",
          "Premium Economy": "PE",
          "First": "F",
          "First Class": "F",
          "E": "E",
          "B": "B",
          "BC": "BC",
          "BR": "BR"
        };
        scenario.dimensions.cabinClass = mapping[cabinName] || cabinName;
        return;
      }

      // 4.05. And fare product is "RS"  — selects the round-trip fare product.
      //   RT (default) = normal fare, legs combine freely.
      //   RS           = Return Special, provider-packaged onward+return.
      const fareProductMatch = stepText.match(/fare product is "([^"]+)"/i);
      if (fareProductMatch) {
        const product = fareProductMatch[1].trim().toUpperCase();
        const allowed = ['RT', 'RS'];
        if (!allowed.includes(product)) {
          const baseName = path.basename(filePath || 'unknown.feature');
          throw new Error(
            `Fare product '${fareProductMatch[1]}' in ${baseName} line ${lineNum} is not supported. ` +
            `Expected one of: ${allowed.join(', ')}`
          );
        }
        scenario.dimensions.fareProduct = product;
        return;
      }

      // 4.1. And user selects cabin "..."
      const selectsCabinMatch = stepText.match(/user selects cabin "([^"]+)"/i);
      if (selectsCabinMatch) {
        const cabinName = selectsCabinMatch[1].trim();
        const mapping = {
          "Economy": "E",
          "Economy Class": "E",
          "Business": "B",
          "Business Class": "B",
          "Premium Economy": "PE",
          "First": "F",
          "First Class": "F",
          "E": "E",
          "B": "B",
          "BC": "BC",
          "BR": "BR"
        };
        scenario.dimensions.cabinClass = mapping[cabinName] || cabinName;
        return;
      }

      // 5. Given user executes workflow "standardBookingFlow"
      const flowMatch = stepText.match(/(?:execution flow is|user executes workflow) "([^"]+)"/i);
      if (flowMatch) {
        scenario.flow = flowMatch[1].trim();
        return;
      }

      // 5.1. And user requests "free" SSR / And user requests "paid" SSR
      const ssrPurchaseMatch = stepText.match(/user requests "(free|paid)" ssr/i);
      if (ssrPurchaseMatch) {
        scenario.dimensions.ssrPurchaseType = ssrPurchaseMatch[1].toUpperCase();
        return;
      }

      // 6. When search dates are offset by "3" and "7" days
      const offsetsMatch = stepText.match(/search dates are offset by "(\d+)" and "(\d+)" days/i);
      if (offsetsMatch) {
        scenario.dataset.onwardDate = `{{futureDate:${offsetsMatch[1]}}}`;
        scenario.dataset.returnDate = `{{futureDate:${offsetsMatch[2]}}}`;
        return;
      }

      // 7. When search onward date offset is "3"
      const onwardOffsetMatch = stepText.match(/search onward date offset is "(\d+)"/i);
      if (onwardOffsetMatch) {
        scenario.dataset.onwardDate = `{{futureDate:${onwardOffsetMatch[1]}}}`;
        return;
      }

      // 8. And search return date offset is "7"
      const returnOffsetMatch = stepText.match(/search return date offset is "(\d+)"/i);
      if (returnOffsetMatch) {
        scenario.dataset.returnDate = `{{futureDate:${returnOffsetMatch[1]}}}`;
        return;
      }

      // 9. When search for multicity sectors "DEL-BOM, BOM-BLR"
      const multicityMatch = stepText.match(/search for multicity sectors "([^"]+)"/);
      if (multicityMatch) {
        scenario.dimensions.tripType = 'MC';
        const sectorStrings = multicityMatch[1].split(',').map(s => s.trim());
        const sectors = sectorStrings.map((s, idx) => {
          const [origin, destination] = s.split('-');
          return {
            origin: origin.toUpperCase(),
            destination: destination.toUpperCase(),
            date: `{{futureDate:${3 + idx * 4}}}`
          };
        });
        scenario.dataset.sectors = sectors;
        delete scenario.dataset.origin;
        delete scenario.dataset.destination;
        
        const isInt = sectors.some(s => s.origin === 'DXB' || s.destination === 'DXB' || s.origin === 'LHR' || s.destination === 'LHR' || s.origin === 'AMS' || s.destination === 'AMS');
        scenario.dimensions.sectorType = isInt ? 'INT' : 'DOM';
        scenario.dataset.sectorPool = isInt ? 'multicity_int' : 'domestic';
        if (!scenario.tags.includes('multicity')) scenario.tags.push('multicity');
        return;
      }

      // 9.1 When search for (domestic|international) multicity flight (DYNAMIC multicity route generation)
      const multicityMatchDynamic = stepText.match(/search for (domestic|international) multicity flight/i);
      if (multicityMatchDynamic) {
        const secType = multicityMatchDynamic[1].toUpperCase() === 'DOMESTIC' ? 'DOM' : 'INT';
        scenario.dimensions.tripType = 'MC';
        scenario.dimensions.sectorType = secType;
        delete scenario.dataset.sectors;
        delete scenario.dataset.origin;
        delete scenario.dataset.destination;
        scenario.dataset.sectorPool = secType === 'DOM' ? 'domestic' : 'multicity_int';
        if (!scenario.tags.includes('multicity')) scenario.tags.push('multicity');
        if (!scenario.tags.includes(secType.toLowerCase())) scenario.tags.push(secType.toLowerCase());
        return;
      }

      // 10. When search for (domestic|international) (OW|RT|RS) flight from "DEL" to "BOM"
      const flightMatch = stepText.match(/search for (domestic|international) (OW|RT|RS) flight from "([^"]+)" to "([^"]+)"/i);
      if (flightMatch) {
        const secType = flightMatch[1].toUpperCase() === 'DOMESTIC' ? 'DOM' : 'INT';
        const rawTripType = flightMatch[2].toUpperCase();
        // RS ("Return Special") is a round-trip fare product, not a distinct
        // trip shape — it needs the same two-leg/return-date handling as RT,
        // differing only in which ExpressSearch FareType gets sent.
        const tripType = rawTripType === 'RS' ? 'RT' : rawTripType;

        scenario.dimensions.sectorType = secType;
        scenario.dimensions.tripType = tripType;
        if (rawTripType === 'RS') scenario.dimensions.fareProduct = 'RS';
        scenario.dataset.origin = flightMatch[3].toUpperCase();
        scenario.dataset.destination = flightMatch[4].toUpperCase();
        scenario.dataset.sectorPool = secType === 'DOM' ? 'domestic' : 'international';

        if (tripType === 'RT') {
          scenario.dataset.returnDate = '{{futureDate:7}}';
          if (!scenario.tags.includes('roundtrip')) scenario.tags.push('roundtrip');
        } else {
          if (!scenario.tags.includes('oneway')) scenario.tags.push('oneway');
        }
        if (rawTripType === 'RS' && !scenario.tags.includes('rs')) scenario.tags.push('rs');
        if (!scenario.tags.includes(secType.toLowerCase())) scenario.tags.push(secType.toLowerCase());
        return;
      }

      // 10.1 When search for (domestic|international) (OW|RT|RS) flight (DYNAMIC route generation)
      const flightMatchDynamic = stepText.match(/search for (domestic|international) (OW|RT|RS) flight/i);
      if (flightMatchDynamic) {
        const secType = flightMatchDynamic[1].toUpperCase() === 'DOMESTIC' ? 'DOM' : 'INT';
        const rawTripType = flightMatchDynamic[2].toUpperCase();
        const tripType = rawTripType === 'RS' ? 'RT' : rawTripType;

        scenario.dimensions.sectorType = secType;
        scenario.dimensions.tripType = tripType;
        if (rawTripType === 'RS') scenario.dimensions.fareProduct = 'RS';
        delete scenario.dataset.origin;
        delete scenario.dataset.destination;
        scenario.dataset.sectorPool = secType === 'DOM' ? 'domestic' : 'international';

        if (tripType === 'RT') {
          scenario.dataset.returnDate = '{{futureDate:7}}';
          if (!scenario.tags.includes('roundtrip')) scenario.tags.push('roundtrip');
        } else {
          if (!scenario.tags.includes('oneway')) scenario.tags.push('oneway');
        }
        if (rawTripType === 'RS' && !scenario.tags.includes('rs')) scenario.tags.push('rs');
        if (!scenario.tags.includes(secType.toLowerCase())) scenario.tags.push(secType.toLowerCase());
        return;
      }

      // 11. Then validate at least one flight result exists
      if (stepText.includes('validate at least one flight result exists')) {
        if (!scenario.validations.validators.includes('availability')) {
          scenario.validations.validators.push('availability');
        }
        return;
      }

      // 12. And validate airline(s) returned is/are "6E, AI, SG"
      const carrierMatch = stepText.match(/validate airline(?:s)? returned (?:is|are) "([^"]+)"/i);
      if (carrierMatch) {
        const codes = carrierMatch[1].toUpperCase();
        this._validateAirline(codes, lineNum, filePath);
        scenario.dimensions.airline = codes;
        if (!scenario.validations.validators.includes('availability')) {
          scenario.validations.validators.push('availability');
        }
        return;
      }

      // 12.1. And validate airline(s) "6E, AI, SG" is/are present in the response
      const carrierPresentMatch = stepText.match(/validate airline(?:s)? "([^"]+)" (?:is|are) present in the response/i);
      if (carrierPresentMatch) {
        const codes = carrierPresentMatch[1].toUpperCase();
        this._validateAirline(codes, lineNum, filePath);
        scenario.dimensions.airline = codes;
        if (!scenario.validations.validators.includes('availability')) {
          scenario.validations.validators.push('availability');
        }
        return;
      }

      // 13. And validate no airline leakage occurs
      if (stepText.includes('validate no airline leakage occurs')) {
        if (!scenario.validations.validators.includes('airlineLeakage')) {
          scenario.validations.validators.push('airlineLeakage');
        }
        return;
      }

      // 13.1. And validate all returned flights are direct
      if (stepText.match(/validate all returned flights are direct/i)) {
        if (!scenario.validations.validators.includes('directFlight')) {
          scenario.validations.validators.push('directFlight');
        }
        return;
      }

      // 13.2. And validate flights are returned for "..." if available
      const nearbyAssertMatch = stepText.match(/validate flights are returned for "([^"]+)" if available/i);
      if (nearbyAssertMatch) {
        scenario.dimensions.nearbyAirport = nearbyAssertMatch[1].toUpperCase().trim();
        if (!scenario.validations.validators.includes('nearbyAirport')) {
          scenario.validations.validators.push('nearbyAirport');
        }
        return;
      }

      // 13.3. And validate all returned flights belong to "..."
      const cabinAssertMatch = stepText.match(/validate all returned flights belong to "([^"]+)"/i);
      if (cabinAssertMatch) {
        const cabinVal = cabinAssertMatch[1].trim().toUpperCase();
        scenario.dimensions.expectedCabin = cabinVal;
        if (!scenario.validations.validators.includes('cabinClass')) {
          scenario.validations.validators.push('cabinClass');
        }
        return;
      }

      // 13.4. And validate provider "1SN" availability
      //
      // Ground-truth GDS/NDC provider check: a marketplace search that surfaces AT LEAST
      // ONE carrier resolving to the named provider (via airlineResolver's `_providers`
      // tag, see providerAvailabilityValidator) proves that provider served live
      // inventory — a specific carrier is not asserted, since carriers move between
      // providers run to run (e.g. LX seen under 1G, SB, AM).
      //
      // ACCUMULATES into `dimensions.expectedProviders` (plural array). A scenario may
      // stack several of these lines (e.g. SB + AM + 1G + VTL on the common international
      // oneway) and every one of them must be asserted independently. This used to be a
      // scalar `dimensions.expectedProvider` assignment, so each stacked step silently
      // overwrote the previous one and only the LAST provider in the scenario was ever
      // checked — the earlier assertions were no-ops with no warning.
      const providerAssertMatch = stepText.match(/validate provider "([^"]+)" availability/i);
      if (providerAssertMatch) {
        const providerCode = providerAssertMatch[1].toUpperCase().trim();
        scenario.dimensions.expectedProviders = scenario.dimensions.expectedProviders || [];
        if (!scenario.dimensions.expectedProviders.includes(providerCode)) {
          scenario.dimensions.expectedProviders.push(providerCode);
        }
        if (!scenario.validations.validators.includes('providerAvailability')) {
          scenario.validations.validators.push('providerAvailability');
        }
        return;
      }

      // 14. Then validate using validators "business, pricing, segment"
      //
      // This must MERGE into scenario.validations.validators, not replace it: earlier
      // steps in the same scenario ("validate at least one flight result exists",
      // "validate airline(s) ... present", "validate no airline leakage occurs", etc.)
      // already pushed validators (availability, airlineLeakage, ...) onto that array.
      // Overwriting here silently dropped the availability check from every scenario
      // that combines both step types — which is most pricing/SSR/fareRule scenarios —
      // so a genuinely empty GetExpSearch (no Trips) went unflagged and cascaded into a
      // confusing downstream failure (e.g. SmartPricer "Index cannot be empty") instead
      // of a clear "no availability" failure at the step that actually caused it.
      const validatorsMatch = stepText.match(/validate using validators "([^"]+)"/i);
      if (validatorsMatch) {
        const vals = validatorsMatch[1].split(',').map(v => v.trim()).filter(Boolean);
        vals.forEach(v => {
          if (!scenario.validations.validators.includes(v)) {
            scenario.validations.validators.push(v);
          }
        });
        return;
      }
    }
  }

  _expandOutline(outline, scenarios, filePath) {
    if (!outline || !outline.examplesHeaders || !outline.examplesRows.length) return;

    outline.examplesRows.forEach(row => {
      let instanceName = outline.nameTemplate;
      outline.examplesHeaders.forEach((header, idx) => {
        const val = row.cells[idx] || '';
        instanceName = instanceName.replace(new RegExp(`<${header}>`, 'g'), val);
      });

      const scenarioId = 'BDD_' + instanceName.replace(/[^a-zA-Z0-9_]/g, '_').toUpperCase();

      const inst = {
        id: scenarioId,
        name: `${outline.featureName} - ${instanceName}`,
        tags: [...outline.tags],
        priority: outline.priority || 1,
        dimensions: {
          sectorType: 'DOM',
          tripType: 'OW',
          passengerMix: { ADT: 1, CHD: 0, INF: 0 },
          airline: '',
          cabinClass: 'E',
          fareProduct: 'RT',   // round-trip fare product: RT (normal) | RS (Return Special)
          searchMode: 'marketplace'
        },
        dataset: {
          sectorPool: 'domestic',
          selectionStrategy: 'RANDOM',
          onwardDate: '{{futureDate:3}}',
          returnDate: null
        },
        flow: 'availabilityOnlyFlow',
        validations: {
          validators: []
        }
      };

      if (outline.retries !== undefined) {
        inst.retries = outline.retries;
      }

      // Add row values as scenario tags
      row.cells.forEach(val => {
        if (val && val.trim()) {
          const cleanTag = val.trim().replace(/\s+/g, '_').toUpperCase();
          if (!inst.tags.includes(cleanTag)) {
            inst.tags.push(cleanTag);
          }
        }
      });

      // Expand step templates
      outline.steps.forEach(stepObj => {
        let interpolated = stepObj.text;
        outline.examplesHeaders.forEach((header, idx) => {
          const val = row.cells[idx] || '';
          interpolated = interpolated.replace(new RegExp(`<${header}>`, 'g'), val);
        });
        this._parseStepLine(interpolated, inst, stepObj.lineNum, filePath);
      });

      scenarios.push(inst);
    });
  }
}

module.exports = new BddInterpreter();
