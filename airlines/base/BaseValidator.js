'use strict';

/**
 * BaseValidator — Abstract base class for all step/scenario validators.
 *
 * Validators NEVER throw. They return a structured result so the pipeline
 * can collect ALL errors before deciding pass/fail.
 *
 * To add a new validator:
 *   1. Extend this class
 *   2. Implement validate()
 *   3. Register in validations/registry.js
 */
class BaseValidator {
  /**
   * @param {string} name - Unique name used in scenario JSON and reports
   */
  constructor(name) {
    if (!name) throw new Error('BaseValidator requires a name');
    this.name = name;
  }

  /**
   * Run validation on a response.
   * Must be overridden by subclasses.
   *
   * @param {Object} response   - Axios response object { status, data, headers }
   * @param {Object} context    - Current test context (saved variables)
   * @param {Object} scenario   - Full scenario definition
   * @param {Object} step       - Current step definition
   * @returns {{ passed: boolean, errors: string[], warnings: string[] }}
   */
  // eslint-disable-next-line no-unused-vars
  validate(response, context, scenario, step) {
    throw new Error(`[${this.name}] validate() must be implemented`);
  }

  // ─────────────────────────────────────────────
  // Result helpers
  // ─────────────────────────────────────────────

  /**
   * Returns a passing validation result
   * @param {string} [message] - Optional custom success message
   */
  pass(message = '') {
    return { passed: true, errors: [], warnings: [], message };
  }

  /**
   * Returns a failing validation result
   * @param {...string} errors
   */
  fail(...errors) {
    return { passed: false, errors, warnings: [] };
  }

  /**
   * Returns a passing result with warnings
   * @param {...string} warnings
   */
  warn(...warnings) {
    return { passed: true, errors: [], warnings };
  }

  /**
   * Safe accessor — returns undefined without throwing if path doesn't exist
   * @param {Object} obj
   * @param {string} path - dot-notation path
   */
  get(obj, path) {
    return path.split('.').reduce((acc, key) => {
      if (acc === null || acc === undefined) return undefined;
      // Support array index notation e.g. "Trips[0]"
      const arrMatch = key.match(/^(\w+)\[(\d+)\]$/);
      if (arrMatch) return acc[arrMatch[1]]?.[parseInt(arrMatch[2])];
      return acc[key];
    }, obj);
  }
  /**
   * Resolve a journey's real flight legs, in order — the single source of truth for
   * every validator that needs to know how many legs a journey has and each one's
   * own FlightNo/From/To.
   *
   * Two response shapes, both handled:
   *  - Priced/nested stage: `Segments[].Flight` already carries reliable
   *    DepartureCode/ArrivalCode/FlightNo per real leg. Only a technical-halt entry
   *    (Type "H", see below) is excluded.
   *  - Search stage: `journey.JourneyKey` is the authoritative source — a `~`-separated
   *    list of `,`-separated per-REAL-leg descriptors (`Carrier,FlightNo,From,To,
   *    DepartureTime,ArrivalTime,DepTerminal,ArrTerminal,Duration,`), one entry per real
   *    leg only — never a technical halt. Verified complete across every shape captured:
   *    a direct flight (single entry, no `~`), a real connection (two entries — 6E
   *    BOM-AMD-DEL, IX DEL-PNQ-BLR), and — critically — a connection where the
   *    `Connections` entry ITSELF has `FlightNo/From/To: null` (an international 6E
   *    BOM-HYD-DXB candidate: `Connections[0].FlightNo` was null, but JourneyKey still
   *    carried the real value, "1465"). `Connections`/`Stops`/`Type` are used only as a
   *    fallback when `JourneyKey` is missing or fails to parse:
   *      - `Stops: 0` — exactly one real leg, the journey's own top-level fields
   *        (FlightNo/From/To/DepartureTime/ArrivalTime), regardless of what
   *        `Connections` contains — a `Type: "H"` technical-halt entry (same physical
   *        flight, intermediate stop) or a `Type: "C"` entry that just mirrors the
   *        journey exactly. Neither is a second leg.
   *      - `Stops >= 1` — leg 1 = the journey's own fields; each subsequent leg is one
   *        `Connections` entry with `Type: "C"`, whose `Airport` is the CONNECTION point
   *        — that leg's own departure (the arrival of the preceding leg), never its
   *        arrival. `Type: "H"` entries are excluded the same way as the Stops:0 case.
   *
   * @param {Object} journey
   * @returns {Object[]} each entry has at least FlightNo/From/To/DepartureTime/
   *   ArrivalTime correct for that leg. When resolved via JourneyKey the entry carries
   *   only those parsed fields; when resolved via the Connections/Stops fallback it is
   *   the original segment/connection/journey object (VAC, MAC, Cabin, FareClass, ...
   *   all preserved) with only From/To/ArrivalTime/DepartureTime corrected.
   */
  _segmentsOf(journey) {
    if (!journey) return [];

    if (Array.isArray(journey.Segments) && journey.Segments.length > 0) {
      return journey.Segments.filter(s => (s?.Flight || s)?.Type !== 'H');
    }

    const legsFromKey = this._parseJourneyKey(journey.JourneyKey);
    if (legsFromKey) return legsFromKey;

    const connections = Array.isArray(journey.Connections) ? journey.Connections : [];
    const realConnections = connections.filter(c => c && c.Type === 'C');
    const stops = Number(journey.Stops ?? 0);

    if (stops === 0 || realConnections.length === 0) {
      if (journey.FlightNo || journey.VAC) return [journey];
      return connections.length ? [connections[0]] : [];
    }

    const legs = [{ ...journey, To: realConnections[0].Airport, ArrivalTime: undefined }];
    realConnections.forEach((c, i) => {
      const isLast = i === realConnections.length - 1;
      legs.push({
        ...c,
        From: c.Airport,
        To: isLast ? journey.To : realConnections[i + 1].Airport,
        DepartureTime: undefined,
        ArrivalTime: isLast ? journey.ArrivalTime : undefined
      });
    });
    return legs;
  }

  /**
   * Parse a search-stage `JourneyKey` into its per-leg descriptors. Returns null (not an
   * empty array) when the key is missing or any leg fails to parse a FlightNo/From/To, so
   * callers can tell "no usable key, fall back to Connections/Stops" apart from
   * "genuinely zero legs".
   * @param {string} journeyKey
   * @returns {Object[]|null}
   */
  _parseJourneyKey(journeyKey) {
    if (!journeyKey || typeof journeyKey !== 'string') return null;

    // Two different per-leg comma formats share this `~`-joined JourneyKey shape:
    //   B2B:  MAC,FlightNo,From,To,DepartureTime,ArrivalTime,...,Duration   (9 fields)
    //   B2C:  From-To,FlightNo,MAC,Date,Cabin                              (5 fields,
    //         route as one "XXX-YYY" field) — reproduced live, e.g.
    //         "DEL-IXC,1743,AI,2026-09-24,E~IXC-BOM,472,AI,2026-09-24,E" for a real
    //         connecting AI itinerary (docs/changes/2026-09-21-phase1-first-feature-file.md).
    // This matters beyond just not mis-parsing: B2C's own `Connections` array entries for a
    // connecting leg carry no FlightNo at all (only Airport/Duration/Type), so the JourneyKey
    // is the ONLY place a connecting leg's real FlightNo/From/To can be recovered from at all —
    // detect which format each leg is in rather than assuming one.
    const legs = journeyKey.split('~').filter(Boolean).map(part => {
      const f = part.split(',');
      const routeMatch = f[0] && f[0].match(/^([A-Z]{3})-([A-Z]{3})$/i);
      if (routeMatch) {
        return {
          From: routeMatch[1].toUpperCase(),
          To: routeMatch[2].toUpperCase(),
          FlightNo: f[1] || undefined,
          MAC: f[2] || undefined,
          DepartureTime: f[3] || undefined,
          Cabin: f[4] || undefined
        };
      }
      return {
        MAC: f[0] || undefined,
        FlightNo: f[1] || undefined,
        From: f[2] || undefined,
        To: f[3] || undefined,
        DepartureTime: f[4] || undefined,
        ArrivalTime: f[5] || undefined,
        Duration: f[8] || undefined
      };
    });
    // Guard against a leg that matched neither format cleanly (both FlightNo/From/To land on
    // *some* truthy string either way if the B2B field positions are blindly trusted, so
    // require From/To to actually look like IATA airport codes — this is what caught the
    // original mis-parse, From="AI"/To="2026-09-24", before the format detection above).
    const looksLikeAirportCode = code => typeof code === 'string' && /^[A-Z]{3}$/i.test(code);
    return legs.length > 0 && legs.every(l => l.FlightNo && looksLikeAirportCode(l.From) && looksLikeAirportCode(l.To))
      ? legs
      : null;
  }

  /**
   * Helper to get the first flight segment in a journey
   * @param {Object} journey
   * @returns {Object|null}
   */
  _firstSegment(journey) {
    const segs = this._segmentsOf(journey);
    return segs.length > 0 ? (segs[0].Flight || segs[0]) : null;
  }

  /**
   * Helper to get the last flight segment in a journey
   * @param {Object} journey
   * @returns {Object|null}
   */
  _lastSegment(journey) {
    const segs = this._segmentsOf(journey);
    return segs.length > 0 ? (segs[segs.length - 1].Flight || segs[segs.length - 1]) : null;
  }
}

module.exports = BaseValidator;
