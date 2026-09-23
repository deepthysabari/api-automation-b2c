Feature: Common International Roundtrip Flight Passenger Mixes

  # Shape A: marketplace search, sector picked at random, pax mix varied per row.

  @international @roundtrip @availability @common @pax_mixes @retries:2
  Scenario Outline: Validate International Roundtrip Availability for pax mix <mix>
    Given user searches all airlines
    And passenger mix is "<mix>"
    When search for international RT flight
    Then validate at least one flight result exists

    Examples:
      | mix                 |
      | 2 ADT               |
      | 1 ADT, 1 CHD        |
      | 1 ADT, 1 CHD, 1 INF |
