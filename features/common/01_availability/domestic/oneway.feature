Feature: Common Domestic Oneway Flight Availability

  # Shape A: common marketplace search — sector picked AT RANDOM from
  # config/sectorPools/domestic.json (not pinned to one route). This is safe because
  # scenarios/generator.js spreads the picked route's own `airlines` array straight into
  # `dataset.airlines`, and availabilityValidator scopes "validate airlines ... are present" to
  # the intersection of the requested list and that route's own array (see
  # validators/availability/availabilityValidator.js) — so whichever route the random draw
  # lands on, only the carriers THAT route actually carries (per its live-verified `airlines`
  # entry in the pool) get asserted, never the full list against a route that was never
  # expected to carry all of it.
  #
  # `SB` is asserted as the one provider check because it showed up live on every one of the 7
  # domestic routes sampled while building this pool (2026-09-21) — a safe universal baseline
  # regardless of which route gets picked.
  @domestic @oneway @availability @common
  Scenario: Validate expected airlines are present in common Domestic Oneway search
    Given user searches all airlines
    When search for domestic OW flight
    Then validate at least one flight result exists
    And validate airlines "6E, AI, IX, QP, SG, 9I, S5" are present in the response
    And validate provider "SB" availability

  # Shape B: niche carriers that fly only specific sectors — a random marketplace pick from
  # Shape A can't reliably prove their availability (9I only confirmed live on COK-BLR, S5 only
  # on BLR-PNQ, IC only on SDW-PNQ — see config/sectorPools/domestic.json's `_verifiedLive`
  # notes). `Given user selects airline "<airline>"` WITHOUT a following "user searches all
  # airlines" line puts the scenario in genuine preferred mode, so
  # engine/sectorResolutionEngine.js scopes route selection to that carrier's own pooled
  # route(s) instead of landing on a random route that never carries it — same convention the
  # B2B project uses (features/s3_verification/domestic_availability.feature "Shape B").
  #
  # `retry with alternate dates if no availability`: niche/regional carriers genuinely don't fly
  # every day (IC's SDW-PNQ, for instance, is a small regional route) — opt-in date retry avoids
  # a false failure on a day that carrier simply has no departure, per
  # engine/runner.js `_wireDateRetry`.
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
