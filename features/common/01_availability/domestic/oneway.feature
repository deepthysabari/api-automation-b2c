Feature: Common Domestic Oneway Flight Availability

  # Anchored to DEL-BOM — the only route confirmed against live B2C beta inventory so far
  # (config/sectorPools/domestic.json). Explicit origin/destination makes
  # sectorResolutionEngine use this exact route (`_isHardcoded: true`), bypassing random pool
  # selection, so the airline/provider lists below are scoped to what a real marketplace
  # search on DEL-BOM actually returned (captured live 2026-09-21), not ported from the B2B
  # project's own list — B2C serves a different carrier/provider mix on the same city pair.
  # See docs/changes/2026-09-21-phase1-first-feature-file.md.
  #
  # `IXW` also appeared live in the VAC list but is NOT asserted below — it isn't registered
  # in configs/airlines.json at all (a gap worth a dedicated look, not fabricated here).
  #
  # `TSO` also appeared live (3/3 standalone captures) but is deliberately NOT asserted here:
  # it's the same provider docs/changes/2026-09-17-phase1-core-flow-live-verification.md found
  # failing to price (Code 1601), and it was observed missing from one full Jest run of this
  # exact scenario despite passing in isolated captures — treat it as flaky beta inventory,
  # not a reliable smoke-suite assertion, until re-confirmed.
  @domestic @oneway @availability @common
  Scenario: Validate expected airlines are present in common Domestic Oneway search
    Given user searches all airlines
    When search for domestic OW flight from "DEL" to "BOM"
    Then validate at least one flight result exists
    And validate airlines "6E, AI, IX, QP, SG" are present in the response
    And validate provider "SB" availability
