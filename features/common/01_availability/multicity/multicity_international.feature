Feature: Multicity International Flight Availability

  # Explicit, hardcoded sector chains — the international multicity equivalent of the domestic
  # dynamic-stitch scenario. Each itinerary is business-given and live-verified individually.
  # Rationale, mechanism, and live-verification history: docs/changes/2026-09-22-international-multicity.md

  @international @multicity @availability @common
  Scenario: Validate BLR-AUH-AMS-ZRH-AUH-BLR Multicity Availability
    Given user searches all airlines
    When search for multicity sectors "BLR-AUH, AUH-AMS, ZRH-AUH, AUH-BLR"
    Then validate at least one flight result exists

  @international @multicity @availability @common
  Scenario: Validate COK-DXB-DOH Multicity Availability
    Given user searches all airlines
    When search for multicity sectors "COK-DXB, DXB-DOH"
    Then validate at least one flight result exists
