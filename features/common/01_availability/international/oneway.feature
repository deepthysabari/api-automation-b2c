Feature: Common International Oneway Flight Availability

  # Anchored to BOM-DXB. Airline/provider lists are live-verified, not ported from B2B.
  # Rationale, mechanism, and live-verification history: docs/changes/2026-09-21-phase1-first-feature-file.md
  @international @oneway @availability @common @retries:1
  Scenario: Validate expected airlines are present in common International Oneway search
    Given user searches all airlines
    When search for international OW flight from "BOM" to "DXB"
    Then validate at least one flight result exists
    And validate airlines "6E, AI, EK, EY, G9, GF, IX, QR, SV, UL, WY" are present in the response
    And validate provider "SB" availability
    And validate provider "1G" availability
