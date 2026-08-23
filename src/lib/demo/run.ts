/**
 * Drives the REAL engine, stage 1 through stage 5, over the sample fixtures.
 *
 * This is the whole demo: no database, no LLM, no network. `src/lib/engine/` is
 * pure functions by design, so feeding it in-memory data exercises exactly the
 * code path production will use — the only thing swapped out is where the rows
 * came from.
 */

import type { PricedCandidate } from "@/lib/engine/candidate";
import { computeCo2 } from "@/lib/engine/co2";
import { parseProfile } from "@/lib/engine/profile";
import { runStage1 } from "@/lib/engine/stage1";
import { runStage3, type ScoringInput } from "@/lib/engine/stage3";
import { runStage4 } from "@/lib/engine/stage4";
import { runStage5, type ExplainabilityPayload } from "@/lib/engine/stage5";
import { computeTco, type VariantEconomics } from "@/lib/engine/tco";

import {
  AS_OF,
  ENGINE_VERSION,
  emissionFactors,
  FLEET,
  infra,
  onRoadFactors,
  profileInput,
  tables,
} from "./fixtures";

/** A stage-2 calculation that failed for one vehicle, surfaced rather than swallowed. */
export interface EconomicsFailure {
  variantId: string;
  name: string;
  calculation: "tco" | "co2";
  code: string;
  reason: string;
}

export interface DemoRun {
  payload: ExplainabilityPayload;
  /** Vehicles that survived stage 1 but could not be costed, and why. */
  economicsFailures: EconomicsFailure[];
}

export function runDemo(): DemoRun {
  const profile = parseProfile(profileInput);
  const byId = new Map(FLEET.map((v) => [v.variant.variantId, v]));

  // ---- stage 1: hard filters + fuel feasibility gates -----------------------
  const stage1 = runStage1({
    profile,
    candidates: FLEET.map((v) => v.variant),
    onRoadFactors,
    infra,
    asOf: AS_OF,
  });

  // ---- stage 2: per-variant economics for each survivor ---------------------
  // Built ONCE and held, because stages 3, 4 and 5 must all be handed the same
  // array in the same order: stage 3 maps over its input positionally, and
  // stages 4 and 5 check the pairing rather than trusting it.
  const scoringInputs: ScoringInput[] = [];
  const economicsFailures: EconomicsFailure[] = [];

  for (const priced of stage1.candidates as PricedCandidate[]) {
    const demo = byId.get(priced.variant.variantId);
    // Cannot happen — stage 1 only ever returns variants it was given — but an
    // unchecked `!` here would be a silent wrong-vehicle bug if that changed.
    if (demo === undefined) continue;

    const exShowroomPaise = priced.variant.exShowroomPaise;
    if (exShowroomPaise === null) continue; // stage 1 already excludes these

    const economics: VariantEconomics = {
      variantId: priced.variant.variantId,
      fuelType: priced.variant.fuelType,
      category: priced.variant.category,
      exShowroomPaise,
      ...demo.economics,
    };

    const tco = computeTco({ profile, price: priced.price, variant: economics, tables });
    if (!tco.ok) {
      economicsFailures.push({
        variantId: economics.variantId,
        name: priced.variant.name,
        calculation: "tco",
        code: tco.code,
        reason: tco.reason,
      });
      continue; // no TCO means nothing to score
    }

    const co2 = computeCo2({
      profile,
      variant: economics,
      factors: emissionFactors,
      asOf: AS_OF,
    });
    if (!co2.ok) {
      economicsFailures.push({
        variantId: economics.variantId,
        name: priced.variant.name,
        calculation: "co2",
        code: co2.code,
        reason: co2.reason,
      });
    }

    scoringInputs.push({
      variant: priced.variant,
      price: priced.price,
      tco: tco.tco,
      // A failed CO2 calculation is a data gap, not a zero.
      co2: co2.ok ? co2.co2 : null,
      commercial: null, // passenger profile — stage 2c does not apply
      serviceCentreCount: demo.serviceCentreCount,
      resaleLiquidityScore: demo.resaleLiquidityScore,
    });
  }

  // ---- stage 3: normalised sub-scores with persona-derived weights ----------
  const stage3 = runStage3({ profile, candidates: scoringInputs, infra });

  // ---- stage 4: diversify and rank -----------------------------------------
  // `limit: 6` rather than the default 5 so the strong hybrid — the vehicle
  // carrying the deliberate data gap — reaches the page instead of being
  // omitted just off the end of the list. Showing how the engine handles
  // missing data is the point of including it.
  const stage4 = runStage4({
    candidates: scoringInputs,
    scored: stage3.scored,
    limit: 6,
  });
  if (!stage4.ok) {
    throw new Error(`Demo stage 4 failed: [${stage4.code}] ${stage4.reason}`);
  }

  // ---- stage 5: explainability payload --------------------------------------
  // `provenance` is deliberately NOT passed. Every figure in the fixtures is
  // invented; attributing invented numbers to invented sources would be the
  // precise lie the provenance rule exists to prevent. Omitted, the engine
  // reports the gap itself, which is the more honest demo beat.
  const stage5 = runStage5({
    profile,
    asOf: AS_OF,
    engineVersion: ENGINE_VERSION,
    stage1,
    candidates: scoringInputs,
    stage3,
    stage4,
  });
  if (!stage5.ok) {
    throw new Error(`Demo stage 5 failed: [${stage5.code}] ${stage5.reason}`);
  }

  return { payload: stage5.payload, economicsFailures };
}
