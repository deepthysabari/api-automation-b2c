Feature: Common Domestic Oneway Student Fare Availability

  # Shape A: marketplace search, sector picked at random, student fare requested.
  # Verified live: Parameters.PaxCategory:"STU" (not the IsStudentFare boolean, confirmed to
  # have zero effect) genuinely returns journeys tagged PaxCategory:"STU" on domestic routes.
  # International: tried 2 routes, both returned a fully empty result — appears domestic-only,
  # not built. See docs/changes/2026-09-23-student-and-defence-fare.md.

  @availability @common @domestic @oneway @studentFare
  Scenario: Validate Domestic Oneway Student Fare Availability
    Given user searches all airlines
    And student fare search is enabled
    When search for domestic OW flight
    Then validate at least one flight result exists
    Then validate using validators "studentFare"
