import type { CandidateVariant, InfraSnapshot } from "./candidate";
import { computeCommercialEconomics, type SensitivityRange } from "./commercial";
import { computeCo2, type EmissionFactor } from "./co2";
import type { OnRoadFactors } from "./on-road";
import { isCommercial, type RecommendationProfile } from "./profile";
import { runStage1 } from "./stage1";
import { runStage3, type ScoringInput } from "./stage3";
import { runStage4 } from "./stage4";
import {
  runStage5,
  type ExplainabilityPayload,
  type ProvenanceRecord,
  type VehicleReferences,
} from "./stage5";
import {
  computeTco,
  type EconomicsTables,
  type VariantEconomics,
} from "./tco";

/**
 * Journey A end to end: stage 1 → per-variant economics → 3 → 4 → 5.
 *
 * The stages are individually pure and individually tested; this is the order
 * they go in. It lives in the engine rather than in a caller because there is
 * exactly one correct ordering and three callers who need it — the demo page,
 * the golden fixtures, and `POST /api/advisor/recommend`. A second copy of this
 * sequence is a second thing to keep in step, and the pairing rules below are
 * precisely what a drifting copy gets wrong.
 *
 * No database, no clock, no network. Feed it rows and it returns a payload.
 */

/**
 * One vehicle, carrying both engine shapes.
 *
 * `CandidateVariant` (what stage 1 filters) and `VariantEconomics` (what the
 * TCO and CO₂ calculations consume) are deliberately different types and
 * neither contains the other — `VariantEconomics` alone carries `segment`, the
 * real-world efficiency pair and the battery fields. Holding both on one object
 * is what keeps a variant's identity and its economics from drifting apart.
 */
export interface PipelineVehicle {
  variant: CandidateVariant;
  /** The identity fields are projected from `variant` at call time. */
  economics: Omit<
    VariantEconomics,
    "variantId" | "fuelType" | "category" | "exShowroomPaise"
  >;
  /** `null` is a real answer meaning "we do not know", never a zero. */
  serviceCentreCount: number | null;
  resaleLiquidityScore: number | null;
}

/** A stage-2 calculation that failed for one vehicle, surfaced rather than swallowed. */
export interface EconomicsFailure {
  variantId: string;
  name: string;
  calculation: "tco" | "co2" | "commercial";
  code: string;
  reason: string;
}

export interface PipelineInput {
  profile: RecommendationProfile;
  fleet: readonly PipelineVehicle[];
  onRoadFactors: readonly OnRoadFactors[];
  infra: InfraSnapshot;
  tables: EconomicsTables;
  emissionFactors: readonly EmissionFactor[];
  /** ISO `YYYY-MM-DD`. Passed in, never read from the clock, so a stored run
   * replays to the same result (FR-A12). */
  asOf: string;
  engineVersion: string;
  /** Defaults to stage 4's `DEFAULT_RESULT_LIMIT`. */
  limit?: number;
  /** Commercial profiles only. Omit to use the duty cycle's default band. */
  sensitivity?: SensitivityRange;
  provenance?: readonly ProvenanceRecord[];
  /** Keyed by `variantId`. */
  references?: Readonly<Record<string, VehicleReferences>>;
}

export type PipelineResult =
  | {
      ok: true;
      payload: ExplainabilityPayload;
      /** Vehicles that survived stage 1 but could not be costed, and why. */
      economicsFailures: EconomicsFailure[];
    }
  | {
      ok: false;
      /** Which stage refused, so a caller can tell "nothing matched" from
       * "the engine could not pair its own intermediates". */
      stage: 4 | 5;
      code: string;
      reason: string;
      economicsFailures: EconomicsFailure[];
    };

export function runRecommendation(input: PipelineInput): PipelineResult {
  const {
    profile,
    fleet,
    onRoadFactors,
    infra,
    tables,
    emissionFactors,
    asOf,
    engineVersion,
  } = input;

  const byId = new Map(fleet.map((v) => [v.variant.variantId, v]));
  const economicsFailures: EconomicsFailure[] = [];

  // ---- stage 1: hard filters + fuel feasibility gates -----------------------
  const stage1 = runStage1({
    profile,
    candidates: fleet.map((v) => v.variant),
    onRoadFactors,
    infra,
    asOf,
  });

  // ---- stage 2: per-variant economics for each survivor ---------------------
  // Built ONCE and held, because stages 3, 4 and 5 must all be handed the same
  // array in the same order: stage 3 maps over its input positionally, and
  // stages 4 and 5 check the pairing rather than trusting it.
  const scoringInputs: ScoringInput[] = [];

  for (const priced of stage1.candidates) {
    const entry = byId.get(priced.variant.variantId);
    // Cannot happen — stage 1 only ever returns variants it was given — but an
    // unchecked `!` here would be a silent wrong-vehicle bug if that changed.
    if (entry === undefined) continue;

    const exShowroomPaise = priced.variant.exShowroomPaise;
    if (exShowroomPaise === null) continue; // stage 1 already excludes these

    const economics: VariantEconomics = {
      variantId: priced.variant.variantId,
      fuelType: priced.variant.fuelType,
      category: priced.variant.category,
      exShowroomPaise,
      ...entry.economics,
    };

    const tco = computeTco({
      profile,
      price: priced.price,
      variant: economics,
      tables,
    });
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
      asOf,
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

    // ---- stage 2c: commercial economics, for commercial profiles only ------
    let commercial: ScoringInput["commercial"] = null;
    if (isCommercial(profile)) {
      const result = computeCommercialEconomics({
        profile,
        tco: tco.tco,
        sensitivity: input.sensitivity,
      });
      if (result.ok) {
        commercial = result.economics;
      } else {
        economicsFailures.push({
          variantId: economics.variantId,
          name: priced.variant.name,
          calculation: "commercial",
          code: result.code,
          reason: result.reason,
        });
      }
    }

    scoringInputs.push({
      variant: priced.variant,
      price: priced.price,
      tco: tco.tco,
      // A failed CO2 calculation is a data gap, not a zero.
      co2: co2.ok ? co2.co2 : null,
      commercial,
      serviceCentreCount: entry.serviceCentreCount,
      resaleLiquidityScore: entry.resaleLiquidityScore,
    });
  }

  // ---- stage 3: normalised sub-scores with persona-derived weights ----------
  const stage3 = runStage3({ profile, candidates: scoringInputs, infra });

  // ---- stage 4: diversify and rank -----------------------------------------
  const stage4 = runStage4({
    candidates: scoringInputs,
    scored: stage3.scored,
    limit: input.limit,
  });
  if (!stage4.ok) {
    return {
      ok: false,
      stage: 4,
      code: stage4.code,
      reason: stage4.reason,
      economicsFailures,
    };
  }

  // ---- stage 5: explainability payload --------------------------------------
  const stage5 = runStage5({
    profile,
    asOf,
    engineVersion,
    stage1,
    candidates: scoringInputs,
    stage3,
    stage4,
    provenance: input.provenance,
    references: input.references,
  });
  if (!stage5.ok) {
    return {
      ok: false,
      stage: 5,
      code: stage5.code,
      reason: stage5.reason,
      economicsFailures,
    };
  }

  return { ok: true, payload: stage5.payload, economicsFailures };
}
