Feature: Common International Oneway Flight Availability

  # Shape A: marketplace search, sector picked at random from config/sectorPools/international.json.
  # Shape B: carriers that only fly specific sectors get their own dedicated search there.
  # Rationale, mechanism, and live-verification history: docs/changes/2026-09-21-phase1-first-feature-file.md

  @international @oneway @availability @common @retries:1
  Scenario: Validate expected airlines are present in common International Oneway search
    Given user searches all airlines
    When search for international OW flight
    Then validate at least one flight result exists
    And validate airlines "6E, AI, EK, EY, G9, GF, IX, QR, SV, UL, WY" are present in the response
    And validate provider "SB" availability
    And validate provider "1G" availability

  @international @oneway @availability @niche
  Scenario Outline: Validate niche carrier availability for <airline>
    Given user selects airline "<airline>"
    And retry with alternate dates if no availability
    When search for international OW flight
    Then validate at least one flight result exists

    Examples:
      | airline |
      | XY      |
