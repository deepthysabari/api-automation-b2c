Feature: Common Domestic Oneway Senior Citizen Fare Availability

  # Shape A: marketplace search, sector picked at random, senior citizen fare requested.
  # Verified live: Parameters.PaxCategory:"SCP" (not the IsSeniorCitizen boolean, confirmed to
  # have zero effect) genuinely returns journeys tagged PaxCategory:"SCP" on domestic routes.
  # International: tried 3 routes, 0 tagged results on any — appears domestic-only, not built.
  # See docs/changes/2026-09-23-fare-category-paxcategory-fix.md.

  @availability @common @domestic @oneway @seniorCitizen
  Scenario: Validate Domestic Oneway Senior Citizen Fare Availability
    Given user searches all airlines
    And senior citizen fare search is enabled
    When search for domestic OW flight
    Then validate at least one flight result exists
    Then validate using validators "seniorCitizen"
