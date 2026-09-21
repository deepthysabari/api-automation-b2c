Feature: Common Domestic Oneway Flight Availability

  # Shape A: marketplace search, sector picked at random from config/sectorPools/domestic.json.
  # Shape B: carriers that only fly specific sectors get their own dedicated search there.
  # Rationale, mechanism, and live-verification history: docs/changes/2026-09-21-phase1-first-feature-file.md

  @domestic @oneway @availability @common
  Scenario: Validate expected airlines are present in common Domestic Oneway search
    Given user searches all airlines
    When search for domestic OW flight
    Then validate at least one flight result exists
    And validate airlines "6E, AI, IX, QP, SG, 9I, S5" are present in the response
    And validate provider "SB" availability

  @domestic @oneway @availability @niche
  Scenario Outline: Validate niche carrier availability for <airline>
    Given user selects airline "<airline>"
    And retry with alternate dates if no availability
    When search for domestic OW flight
    Then validate at least one flight result exists

    Examples:
      | airline |
      | 9I      |
      | S5      |
      | IC      |
