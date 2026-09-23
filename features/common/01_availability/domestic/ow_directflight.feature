Feature: Common Domestic Oneway Direct Flight Availability

  # Shape A: marketplace search, sector picked at random, IsDirect set in the request.
  # Verified live: with IsDirect true, every returned journey has Stops:0 (294/525 journeys
  # on a sampled DEL-BOM search were direct; the flag genuinely filters, unlike some others —
  # see docs/changes/2026-09-23-fare-type-flags-live-findings.md).

  @availability @common @domestic @oneway @direct
  Scenario: Validate Domestic Oneway Direct Flight Availability
    Given user searches all airlines
    And user enables direct flight filter
    When search for domestic OW flight
    Then validate at least one flight result exists
    And validate all returned flights are direct
