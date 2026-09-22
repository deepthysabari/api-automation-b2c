Feature: Multicity Marketplace Flight Availability

  # Dynamic domestic multicity: sectorResolutionEngine stitches two legs from
  # config/sectorPools/domestic.json rather than a hardcoded sector pair.
  # International multicity is not yet covered — no multicity_int sector pool exists yet.

  @domestic @multicity @availability @common
  Scenario: Validate Domestic Multicity Marketplace Availability
    Given user searches all airlines
    When search for domestic multicity flight
    Then validate at least one flight result exists
