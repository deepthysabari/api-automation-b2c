Feature: Common International Roundtrip Cabin Class Availability

  # Shape A: marketplace search, sector picked at random, cabin varied per row.
  # All 4 cabins verified live to return genuinely cabin-filtered results — see
  # docs/changes/2026-09-22-cabin-class-top-level-field.md.

  @availability @common @international @roundtrip @cabin @retries:2
  Scenario Outline: Validate International Roundtrip <cabinName> Cabin Availability
    Given user searches all airlines
    And user selects cabin "<cabin>"
    When search for international RT flight
    Then validate at least one flight result exists
    And validate all returned flights belong to "<cabin>"

    Examples:
      | cabin | cabinName        |
      | E     | Economy          |
      | PE    | Premium Economy  |
      | B     | Business         |
      | F     | First            |
