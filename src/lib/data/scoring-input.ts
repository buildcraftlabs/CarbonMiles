import type { CandidateVariant } from "@/lib/engine/candidate";
import type { Co2Breakdown } from "@/lib/engine/co2";
import type { CommercialEconomics } from "@/lib/engine/commercial";
import type { OnRoadPrice } from "@/lib/engine/on-road";
import type { ScoringInput } from "@/lib/engine/stage3";
import {
  residualAt,
  resaleCurveFor,
  type ResaleCurvePoint,
  type TcoBreakdown,
  type VariantEconomics,
} from "@/lib/engine/tco";

/**
 * The query layer's projection into stage 3's `ScoringInput`.
 *
 * Two of stage 3's dimensions are fed by facts that live nowhere near the
 * variant row: `reliability` reads `manufacturers.serviceCentreCount`, two
 * joins away, and `resale` reads `resale_curves.liquidityScore`, which belongs
 * to a curve keyed by segment and fuel rather than by vehicle. Until something
 * carries them across, both sub-scores are `null` for every candidate and the
 * ranking is decided by the remaining dimensions alone.
 *
 * This module is the something. It is pure — it imports no Drizzle and no
 * `src/db/` — so it runs against fixtures, and so the row shapes it expects are
 * stated as types the query can be checked against rather than implied by a
 * SQL result.
 *
 * The one rule it exists to enforce: **a missing value stays `null`.** Zero is
 * a real, rankable reading — a manufacturer with no network, a segment nobody
 * buys used — and stage 3 already knows how to drop a `null` dimension and
 * redistribute its weight. Defaulting a gap to zero would rank a vehicle we
 * know nothing about below one with genuinely bad data.
 */

/**
 * A `resale_curves` row as the projection sees it: everything the costing needs
 * plus the liquidity score it has no use for.
 *
 * `resale_curves` is unique on `(segment, fuelType, category, ageYears, asOf)`,
 * and age is the only one of those the curve is looked up by. The caller must
 * therefore collapse to a single `asOf` vintage before handing rows over —
 * otherwise two vintages of the same age are both candidates for the anchor and
 * this year's residual can be paired with last year's liquidity score.
 */
export interface ResaleCurveRow extends ResaleCurvePoint {
  /**
   * `resale_curves.liquidityScore`, a 0–100 index of how readily the segment
   * and fuel actually sell used. `null` where the row carries none. Not money:
   * it is not paise and must not be treated as such.
   */
  liquidityScore: number | null;
  /** `resale_curves.sourceId`, carried for the `sources` block of the response
   * rather than used in any arithmetic. */
  sourceId?: string | null;
  /** `resale_curves.asOf`. Carried for attribution, and so a caller can assert
   * it collapsed to one vintage. */
  asOf?: string;
}

/** Everything the projection needs about one costed candidate. */
export interface ScoringInputProjection {
  variant: CandidateVariant;
  price: OnRoadPrice;
  tco: TcoBreakdown;
  co2: Co2Breakdown | null;
  commercial: CommercialEconomics | null;
  /**
   * `manufacturers.serviceCentreCount` for this variant's manufacturer, reached
   * variant → `vehicle_models.manufacturerId` → `manufacturers`. `null` when we
   * hold no count; `0` when we hold a count of none.
   */
  serviceCentreCount: number | null;
  /** `manufacturers.serviceCentreCountAsOf`, carried for attribution only. */
  serviceCentreCountAsOf?: string | null;
  /**
   * The `segment` / `fuelType` / `category` the resale curve is keyed on — the
   * same three fields `VariantEconomics` carries and `computeTco` filtered the
   * curve by.
   */
  economics: Pick<VariantEconomics, "segment" | "fuelType" | "category">;
  /** Every resale row loaded for this run, of one `asOf` vintage. Rows for
   * other segments and fuels may be present; they are filtered out here. */
  resaleRows: readonly ResaleCurveRow[];
  /** The exit age the residual was taken at — `profile.ownershipYears`, which
   * is also `tco.ownershipYears`. */
  ownershipYears: number;
}

/** Modelling conventions that are ours, not sourced. */
export const PROJECTION_CONVENTIONS = {
  /**
   * The liquidity score is read from the row that anchored the residual, found
   * with the same `resaleCurveFor` + `residualAt` pair `computeTco` used.
   * Reading it off any other row would let the residual and the liquidity claim
   * come from different segments, fuels or ages and silently disagree — the
   * payload would credit a five-year residual and describe a one-year-old car's
   * used market.
   */
  liquidityFollowsTheResidualAnchorRow: true,
  /**
   * A missing count or score projects as `null`, never `0`, and stage 3 drops
   * the dimension and redistributes its weight. A held value of `0` projects as
   * `0`, because it is evidence.
   */
  absentIsNullNeverZero: true,
} as const;

/**
 * The resale row that priced the residual for this candidate, or `null` when no
 * curve covers it.
 *
 * Exported separately from the projection because the response's `sources`
 * block needs the row itself — its `sourceId` and `asOf` — not just the score
 * lifted off it.
 */
export function resaleAnchorRow(
  projection: Pick<
    ScoringInputProjection,
    "economics" | "resaleRows" | "ownershipYears"
  >,
): ResaleCurveRow | null {
  const curve = resaleCurveFor(projection.resaleRows, projection.economics);
  return residualAt(curve, projection.ownershipYears)?.row ?? null;
}

/**
 * Project one costed candidate into the shape stage 3 scores.
 *
 * `serviceCentreCount` passes straight through: the query layer already
 * distinguishes "no row" from "a row holding null" from "a row holding zero",
 * and coalescing here would throw that away.
 */
export function projectScoringInput(
  projection: ScoringInputProjection,
): ScoringInput {
  const anchor = resaleAnchorRow(projection);

  return {
    variant: projection.variant,
    price: projection.price,
    tco: projection.tco,
    co2: projection.co2,
    commercial: projection.commercial,
    serviceCentreCount: projection.serviceCentreCount,
    // `?? null`, never `|| null`: a liquidity score of 0 is a segment nobody
    // buys used, which is a fact, not a gap.
    resaleLiquidityScore: anchor?.liquidityScore ?? null,
  };
}
