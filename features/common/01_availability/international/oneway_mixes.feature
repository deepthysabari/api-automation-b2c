Feature: Common International Oneway Flight Passenger Mixes

  # Shape A: marketplace search, sector picked at random, pax mix varied per row.

  @international @oneway @availability @common @pax_mixes @retries:1
  Scenario Outline: Validate International Oneway Availability for pax mix <mix>
    Given user searches all airlines
    And passenger mix is "<mix>"
    When search for international OW flight
    Then validate at least one flight result exists

    Examples:
      | mix                 |
      | 2 ADT               |
      | 1 ADT, 1 CHD        |
      | 1 ADT, 1 CHD, 1 INF |
