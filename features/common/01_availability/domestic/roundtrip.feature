Feature: Common Domestic Roundtrip Flight Availability

  # Shape A: marketplace search, sector picked at random from config/sectorPools/domestic.json.
  # Same convention as oneway.feature, RT instead of OW.

  @domestic @roundtrip @availability @common
  Scenario: Validate expected airlines are present in common Domestic Roundtrip search
    Given user searches all airlines
    When search for domestic RT flight
    Then validate at least one flight result exists
    And validate airlines "6E, AI, IX, QP, SG, 9I, S5" are present in the response
    And validate provider "SB" availability
