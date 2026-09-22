Feature: Common International Roundtrip Flight Availability

  # Shape A: marketplace search, sector picked at random from config/sectorPools/international.json.
  # Same convention as oneway.feature, RT instead of OW.

  @international @roundtrip @availability @common @retries:1
  Scenario: Validate expected airlines are present in common International Roundtrip search
    Given user searches all airlines
    When search for international RT flight
    Then validate at least one flight result exists
    And validate airlines "6E, AI, EK, EY, G9, GF, IX, QR, SV, UL, WY" are present in the response
    And validate provider "SB" availability
    And validate provider "1G" availability
