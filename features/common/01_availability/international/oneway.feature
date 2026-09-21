Feature: Common International Oneway Flight Availability

  # Anchored to BOM-DXB — same anchor route the B2B project uses for its own international
  # marketplace check, and confirmed live against B2C beta on 2026-09-21 (999 journeys, richly
  # multi-carrier). Explicit origin/destination makes sectorResolutionEngine use this exact
  # route (`_isHardcoded: true`), bypassing random pool selection. Airline/provider lists below
  # are the actual live result, not ported from B2B's own list.
  #
  # `SG` also appeared live in the VAC list here, despite configs/airlines.json only listing
  # `sectorTypes: ["DOM"]` for it — an unverified-capability-flag gap already flagged in
  # docs/changes/2026-09-18-onboard-ai-via-generic-adapter.md, not asserted here until resolved.
  # `GP`/`HR` also appeared live but aren't registered in configs/airlines.json at all.
  #
  # The asserted airline list below is deliberately NARROWER than everything seen live: 8
  # separate live captures across 2 dates found `ET, FZ, KQ, MS, RJ, TK, XY` each present in
  # SOME captures and absent in others (a full, non-partial result either way — this is real
  # day-to-day schedule variance, not a code defect), while `6E, AI, EK, EY, G9, GF, IX, QR,
  # SV, UL, WY` held in every full capture. Asserting the volatile carriers would make this
  # scenario flaky for reasons that have nothing to do with the platform under test.
  #
  # `@retries:1`: separately, repeated sampling also found GetExpSearch's own
  # `Completed: "True"` signal occasionally firing before the async result index is fully
  # populated (1/8 samples returned a single/near-empty-carrier result where the rest returned
  # ~950-1030 journeys across ~16-19 carriers) — a live-API race, not a code defect. A retry
  # re-polls fresh rather than papering over a real miss.
  @international @oneway @availability @common @retries:1
  Scenario: Validate expected airlines are present in common International Oneway search
    Given user searches all airlines
    When search for international OW flight from "BOM" to "DXB"
    Then validate at least one flight result exists
    And validate airlines "6E, AI, EK, EY, G9, GF, IX, QR, SV, UL, WY" are present in the response
    And validate provider "SB" availability
    And validate provider "1G" availability
