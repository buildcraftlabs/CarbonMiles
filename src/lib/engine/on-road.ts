import type { FuelType, VehicleCategory } from "./enums";

/**
 * On-road price: ex-showroom plus the state's road tax, registration fee,
 * first-year insurance and levies (FR-A5).
 *
 * This lives in stage 1 rather than in the economics stage because the budget
 * filter compares against it. Road tax alone runs from roughly 6% to 20%
 * depending on state, price band and fuel, so filtering on ex-showroom would
 * admit vehicles the buyer cannot actually afford — in Karnataka a ₹10L
 * ex-showroom car is comfortably over a ₹11L on-road budget.
 *
 * Stage 2 reuses these functions rather than recomputing: the acquisition leg
 * of TCO is this same number.
 */

/**
 * One row of `state_on_road_factors`, as plain data.
 *
 * `numeric` columns arrive from pg as strings; the query layer in
 * `src/lib/data/` converts them before calling in here. Percentages are percent
 * (18.5, not 0.185) and money is paise, as integers.
 */
export interface OnRoadFactors {
  stateCode: string;
  category: VehicleCategory;
  /** `null` means the row applies to every fuel; a fuel-specific row wins. */
  fuelType: FuelType | null;
  /** Inclusive lower bound of ex-showroom price, in paise. */
  priceBandMinPaise: number;
  /** Exclusive upper bound; `null` is an open-ended top band. */
  priceBandMaxPaise: number | null;
  roadTaxPct: number;
  registrationFeePaise: number;
  insurancePct: number;
  /** Green cess, EV subsidy and similar. Negative for a rebate. */
  otherLevyPaise: number;
  /** ISO `YYYY-MM-DD`. Compared as a string, which orders correctly in that
   * format and avoids dragging a timezone into a pure function. */
  effectiveFrom: string;
}

export interface OnRoadFactorsQuery {
  stateCode: string;
  category: VehicleCategory;
  fuelType: FuelType;
  exShowroomPaise: number;
  /** The run's as-of date, passed in rather than read from the clock so that a
   * stored run replays to the same numbers (FR-A12). */
  asOf: string;
}

export interface OnRoadPrice {
  exShowroomPaise: number;
  roadTaxPaise: number;
  registrationFeePaise: number;
  insurancePaise: number;
  otherLevyPaise: number;
  onRoadPaise: number;
  /** The row that produced the figure, carried into the explainability payload
   * so the breakdown can be attributed rather than asserted. */
  factors: OnRoadFactors;
}

/**
 * Pick the row that governs a given variant in a given state.
 *
 * Rows may overlap legitimately — a state-wide default plus an EV-specific
 * carve-out plus a newer revision of both — so selection is ordered rather
 * than assumed unique: fuel-specific beats fuel-agnostic, then the most
 * recently effective row wins. Returns `null` when nothing applies, which the
 * caller must treat as "cannot price", never as "no tax".
 */
export function selectOnRoadFactors(
  rows: readonly OnRoadFactors[],
  query: OnRoadFactorsQuery,
): OnRoadFactors | null {
  const applicable = rows.filter(
    (row) =>
      row.stateCode === query.stateCode &&
      row.category === query.category &&
      (row.fuelType === null || row.fuelType === query.fuelType) &&
      row.effectiveFrom <= query.asOf &&
      query.exShowroomPaise >= row.priceBandMinPaise &&
      (row.priceBandMaxPaise === null ||
        query.exShowroomPaise < row.priceBandMaxPaise),
  );

  applicable.sort((a, b) => {
    const specificity =
      Number(b.fuelType !== null) - Number(a.fuelType !== null);
    if (specificity !== 0) return specificity;
    return b.effectiveFrom.localeCompare(a.effectiveFrom);
  });

  return applicable[0] ?? null;
}

/** Percentage of a paise amount, rounded to whole paise. */
const pctOf = (basePaise: number, pct: number) =>
  Math.round((basePaise * pct) / 100);

export function computeOnRoadPrice(
  exShowroomPaise: number,
  factors: OnRoadFactors,
): OnRoadPrice {
  const roadTaxPaise = pctOf(exShowroomPaise, factors.roadTaxPct);
  const insurancePaise = pctOf(exShowroomPaise, factors.insurancePct);

  const total =
    exShowroomPaise +
    roadTaxPaise +
    factors.registrationFeePaise +
    insurancePaise +
    factors.otherLevyPaise;

  return {
    exShowroomPaise,
    roadTaxPaise,
    registrationFeePaise: factors.registrationFeePaise,
    insurancePaise,
    otherLevyPaise: factors.otherLevyPaise,
    /** A subsidy large enough to exceed tax plus fees would otherwise produce a
     * negative price; the floor keeps downstream arithmetic sane. */
    onRoadPaise: Math.max(0, total),
    factors,
  };
}
