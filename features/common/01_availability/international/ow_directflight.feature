Feature: Common International Oneway Direct Flight Availability

  # Shape A: marketplace search, sector picked at random, IsDirect set in the request.
  # Verified live: with IsDirect true, every returned journey has Stops:0 (145/145 journeys on
  # a sampled BOM-DXB search) — see docs/changes/2026-09-23-fare-type-flags-live-findings.md.

  @availability @common @international @oneway @direct @retries:2
  Scenario: Validate International Oneway Direct Flight Availability
    Given user searches all airlines
    And user enables direct flight filter
    When search for international OW flight
    Then validate at least one flight result exists
    And validate all returned flights are direct
