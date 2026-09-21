Feature: Domestic Oneway Availability and Pricing

  # First live feature file for this project (see docs/changes/2026-09-21-phase1-first-feature-file.md).
  # Uses "pricingOnlyFlow" deliberately: it stops after GetSPricer, matching the exact chain
  # verified live in docs/changes/2026-09-17-phase1-core-flow-live-verification.md and
  # docs/changes/2026-09-18-onboard-ai-via-generic-adapter.md. CreateItinerary is still B2B-shaped
  # (CLAUDE.md Phase 3, not done yet) — no scenario should reach it until that's fixed.
  #
  # Route comes from config/sectorPools/domestic.json's DEL-BOM entry, the only pool route
  # confirmed against live beta inventory so far.

  @airline:AI @stage:pricing @sector:domestic @tripType:OW @priority:1 @retries:1
  Scenario: Verify Air India Domestic Oneway Search and Pricing
    Given user selects airline "AI"
    And passenger mix is "1 ADT"
    And user executes workflow "pricingOnlyFlow"
    When search for domestic OW flight
    Then validate at least one flight result exists
    And validate airline returned is "AI"
    Then validate using validators "business, pricing, segment"

  @airline:QP @stage:pricing @sector:domestic @tripType:OW @priority:1 @retries:1
  Scenario: Verify Akasa Domestic Oneway Search and Pricing
    Given user selects airline "QP"
    And passenger mix is "1 ADT"
    And user executes workflow "pricingOnlyFlow"
    When search for domestic OW flight
    Then validate at least one flight result exists
    And validate airline returned is "QP"
    Then validate using validators "business, pricing, segment"
