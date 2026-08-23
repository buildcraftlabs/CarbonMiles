import { describe, expect, it } from "vitest";

import type { CandidateVariant, InfraSnapshot } from "@/lib/engine/candidate";
import { computeOnRoadPrice, type OnRoadFactors } from "@/lib/engine/on-road";
import {
  parseProfile,
  type RecommendationProfileInput,
} from "@/lib/engine/profile";
import { runStage3 } from "@/lib/engine/stage3";
import {
  computeTco,
  type EconomicsTables,
  type TcoBreakdown,
  type VariantEconomics,
} from "@/lib/engine/tco";

import {
  projectScoringInput,
  resaleAnchorRow,
  type ResaleCurveRow,
  type ScoringInputProjection,
} from "./scoring-input";

const lakhs = (n: number) => Math.round(n * 10_000_000);

const MH: OnRoadFactors = {
  stateCode: "MH",
  category: "passenger",
  fuelType: null,
  priceBandMinPaise: 0,
  priceBandMaxPaise: null,
  roadTaxPct: 11,
  registrationFeePaise: 60_000,
  insurancePct: 3,
  otherLevyPaise: 0,
  effectiveFrom: "2026-01-01",
};

const price = computeOnRoadPrice(lakhs(8), MH);

const profileInput: RecommendationProfileInput = {
  category: "passenger",
  location: { stateCode: "MH" },
  budget: { maxOnRoadPaise: lakhs(15) },
  usage: { dailyKm: 40, monthlyKm: 1200, typicalTripKm: 25, citySharePct: 70 },
  charging: { homeCharging: true },
  preferences: {},
  financing: { mode: "cash" },
  ownershipYears: 5,
  passengers: 5,
};

const profileOf = (over: Partial<RecommendationProfileInput> = {}) =>
  parseProfile({ ...profileInput, ...over } as RecommendationProfileInput);

const variant = (over: Partial<CandidateVariant> = {}): CandidateVariant => ({
  variantId: "v1",
  modelId: "m1",
  name: "Test Hatchback VXi",
  category: "passenger",
  bodyType: "hatchback",
  status: "active",
  fuelType: "petrol",
  exShowroomPaise: lakhs(8),
  seatingCapacity: 5,
  payloadKg: null,
  realWorldRangeKm: null,
  availableInState: true,
  ...over,
});

const tco = (over: Partial<TcoBreakdown> = {}): TcoBreakdown => {
  const totalPaise = over.totalPaise ?? lakhs(12);
  const totalKm = over.totalKm ?? 72_000;
  return {
    variantId: "v1",
    ownershipYears: 5,
    totalKm,
    acquisitionPaise: lakhs(9),
    energyPaise: lakhs(3),
    maintenancePaise: lakhs(1),
    insuranceRenewalPaise: 50_000_000,
    financingInterestPaise: 0,
    batteryReplacementPaise: 0,
    resaleNominalPaise: lakhs(4),
    resaleCreditPaise: lakhs(3),
    totalPaise,
    costPaisePerKm: totalPaise / totalKm,
    yearly: [],
    assumptions: [],
    ...over,
  };
};

const ECONOMICS: Pick<VariantEconomics, "segment" | "fuelType" | "category"> = {
  segment: "premium_hatchback",
  fuelType: "petrol",
  category: "passenger",
};

const RESIDUALS = [85, 75, 65, 57, 50];

/** A five-year petrol hatchback curve, one liquidity score per row. */
const curve = (
  liquidityByAge: readonly (number | null)[] = [62, 62, 62, 62, 62],
): ResaleCurveRow[] =>
  RESIDUALS.map((residualPct, i) => ({
    ...ECONOMICS,
    ageYears: i + 1,
    residualPct,
    liquidityScore: liquidityByAge[i] ?? null,
    asOf: "2026-04-01",
  }));

const projection = (
  over: Partial<ScoringInputProjection> = {},
): ScoringInputProjection => ({
  variant: variant(),
  price,
  tco: tco(),
  co2: null,
  commercial: null,
  serviceCentreCount: 1500,
  economics: ECONOMICS,
  resaleRows: curve(),
  ownershipYears: 5,
  ...over,
});

const infra: InfraSnapshot = {
  petrol: { type: "petrol", stationCount: 900, percentile: 80, confidenceScore: 90 },
};

describe("projectScoringInput, populated", () => {
  it("carries the service-centre count through untouched", () => {
    expect(projectScoringInput(projection()).serviceCentreCount).toBe(1500);
  });

  it("reads the liquidity score off the curve", () => {
    expect(projectScoringInput(projection()).resaleLiquidityScore).toBe(62);
  });

  it("reads it from the row that priced the residual, not the first row", () => {
    // Exit at 5 years, so the year-5 row is the anchor even though four other
    // rows of the same curve carry a different score.
    const input = projectScoringInput(
      projection({ resaleRows: curve([62, 62, 62, 62, 41]) }),
    );

    expect(input.resaleLiquidityScore).toBe(41);
  });

  it("follows the residual past the end of the curve rather than losing it", () => {
    // An eight-year hold against a five-year curve: `computeTco` holds the
    // five-year residual flat, so the liquidity claim must come from that same
    // five-year row.
    const input = projectScoringInput(
      projection({
        resaleRows: curve([62, 62, 62, 62, 41]),
        ownershipYears: 8,
      }),
    );

    expect(input.resaleLiquidityScore).toBe(41);
    expect(resaleAnchorRow(projection({ ownershipYears: 8 }))?.ageYears).toBe(5);
  });

  it("anchors an interpolated residual to the row it departs from", () => {
    const sparse: ResaleCurveRow[] = [
      { ...ECONOMICS, ageYears: 3, residualPct: 65, liquidityScore: 30 },
      { ...ECONOMICS, ageYears: 5, residualPct: 50, liquidityScore: 70 },
    ];

    const input = projectScoringInput(
      projection({ resaleRows: sparse, ownershipYears: 4 }),
    );

    expect(input.resaleLiquidityScore).toBe(30);
  });

  it("selects the curve for this variant's segment, fuel and category", () => {
    const otherSegment: ResaleCurveRow[] = curve([10, 10, 10, 10, 10]).map(
      (row) => ({ ...row, segment: "midsize_suv" }),
    );
    const otherFuel: ResaleCurveRow[] = curve([20, 20, 20, 20, 20]).map(
      (row) => ({ ...row, fuelType: "diesel" as const }),
    );
    const otherCategory: ResaleCurveRow[] = curve([30, 30, 30, 30, 30]).map(
      (row) => ({ ...row, category: "commercial" as const }),
    );

    const input = projectScoringInput(
      projection({
        resaleRows: [...otherSegment, ...otherFuel, ...otherCategory, ...curve()],
      }),
    );

    expect(input.resaleLiquidityScore).toBe(62);
  });

  it("agrees with the residual computeTco actually credited", () => {
    const economics: VariantEconomics = {
      variantId: "v1",
      ...ECONOMICS,
      exShowroomPaise: lakhs(8),
      realWorldEfficiencyCity: 20,
      realWorldEfficiencyHighway: 25,
      efficiencyUnit: "kmpl",
      batteryKwh: null,
      batteryChemistry: null,
      batteryWarrantyYears: null,
      batteryWarrantyKm: null,
      scheduledServiceCost5yPaise: null,
    };
    const rows = curve([62, 62, 62, 62, 41]);
    const tables: EconomicsTables = {
      energyPrices: {
        petrol: { pricePaise: 10_000, unit: "litre", asOf: "2026-08-01" },
      },
      maintenance: RESIDUALS.map((_, i) => ({
        ...ECONOMICS,
        ownershipYear: i + 1,
        costPaise: 500_000,
        referenceAnnualKm: 12_000,
        marginalCostPaisePerKm: 100,
      })),
      resale: rows,
      batteries: [],
      financeRates: [],
      discountRatePct: 0,
    };

    const result = computeTco({
      profile: profileOf(),
      price,
      variant: economics,
      tables,
    });
    if (!result.ok) throw new Error(`${result.code}: ${result.reason}`);

    const anchor = resaleAnchorRow(projection({ resaleRows: rows }));
    // The row the projection read the liquidity score off is the row whose
    // residual the TCO credited — 50% of a ₹8L ex-showroom.
    expect(anchor?.residualPct).toBe(50);
    expect(result.tco.resaleNominalPaise).toBe(
      Math.round((lakhs(8) * (anchor?.residualPct ?? 0)) / 100),
    );
    expect(anchor?.liquidityScore).toBe(41);
  });
});

describe("projectScoringInput, missing data", () => {
  it("projects null when no curve covers this variant at all", () => {
    const input = projectScoringInput(projection({ resaleRows: [] }));

    expect(input.resaleLiquidityScore).toBeNull();
    expect(input.resaleLiquidityScore).not.toBe(0);
  });

  it("projects null when every row belongs to another segment", () => {
    const elsewhere = curve().map((row) => ({ ...row, segment: "midsize_suv" }));

    expect(
      projectScoringInput(projection({ resaleRows: elsewhere }))
        .resaleLiquidityScore,
    ).toBeNull();
  });

  it("projects null when the anchor row carries no liquidity score", () => {
    // The residual is known; the used-market score for that row is not. The
    // rest of the curve holding one must not stand in for it.
    const input = projectScoringInput(
      projection({ resaleRows: curve([62, 62, 62, 62, null]) }),
    );

    expect(input.resaleLiquidityScore).toBeNull();
  });

  it("keeps a liquidity score of zero, which is a reading and not a gap", () => {
    const input = projectScoringInput(
      projection({ resaleRows: curve([62, 62, 62, 62, 0]) }),
    );

    expect(input.resaleLiquidityScore).toBe(0);
  });

  it("keeps a missing service-centre count null and a count of none zero", () => {
    expect(
      projectScoringInput(projection({ serviceCentreCount: null }))
        .serviceCentreCount,
    ).toBeNull();
    expect(
      projectScoringInput(projection({ serviceCentreCount: 0 }))
        .serviceCentreCount,
    ).toBe(0);
  });

  it("returns no anchor row for an uncovered variant", () => {
    expect(resaleAnchorRow(projection({ resaleRows: [] }))).toBeNull();
  });
});

/**
 * The reason the projection exists: these two dimensions score `null` for every
 * candidate without it, and the null must survive scoring as an unscored
 * dimension rather than as a zero.
 */
describe("projected candidates through stage 3", () => {
  const candidate = (
    id: string,
    over: Partial<ScoringInputProjection> = {},
  ): ScoringInputProjection =>
    projection({
      variant: variant({ variantId: id, modelId: id, name: id.toUpperCase() }),
      tco: tco({ variantId: id }),
      ...over,
    });

  const sub = (
    scored: ReturnType<typeof runStage3>["scored"][number],
    dimension: "reliability" | "resale" | "cost",
  ) => {
    const found = scored.subScores.find((s) => s.dimension === dimension);
    if (found === undefined) throw new Error(`no ${dimension} sub-score`);
    return found;
  };

  it("scores both dimensions once the fields are projected", () => {
    const { scored } = runStage3({
      profile: profileOf(),
      candidates: [
        projectScoringInput(
          candidate("a", {
            serviceCentreCount: 400,
            resaleRows: curve([62, 62, 62, 62, 40]),
          }),
        ),
        projectScoringInput(
          candidate("b", {
            serviceCentreCount: 2000,
            resaleRows: curve([62, 62, 62, 62, 80]),
          }),
        ),
      ],
      infra,
    });

    expect(sub(scored[0], "resale").score).toBe(0);
    expect(sub(scored[1], "resale").score).toBe(100);
    expect(sub(scored[0], "reliability").score).toBe(0);
    expect(sub(scored[1], "reliability").score).toBe(100);
    expect(scored[0].unscored.map((u) => u.dimension)).not.toContain("resale");
  });

  it("leaves resale unscored and redistributes its weight when the curve holds none", () => {
    const { scored, assumptions } = runStage3({
      profile: profileOf(),
      candidates: [
        projectScoringInput(
          candidate("a", { resaleRows: curve([62, 62, 62, 62, 70]) }),
        ),
        projectScoringInput(candidate("b", { resaleRows: [] })),
      ],
      infra,
    });

    const resale = sub(scored[1], "resale");
    expect(resale.score).toBeNull();
    expect(resale.raw).toBeNull();
    expect(resale.weight).toBe(0);
    expect(scored[1].unscored.map((u) => u.dimension)).toContain("resale");
    expect(assumptions.join(" ")).toContain("used-market liquidity score");
    // The weight went somewhere rather than shrinking the total.
    expect(
      scored[1].subScores.reduce((sum, s) => sum + s.weight, 0),
    ).toBeCloseTo(1, 2);
    expect(sub(scored[1], "cost").weight).toBeGreaterThan(
      sub(scored[0], "cost").weight,
    );
  });

  it("does not rank an unknown liquidity below a genuinely bad one", () => {
    // `b` holds no score at all; `c` holds the worst score in the set. If the
    // projection defaulted a gap to 0 these would score the same, and the
    // vehicle we know nothing about would be penalised for it.
    const { scored } = runStage3({
      profile: profileOf(),
      candidates: [
        projectScoringInput(
          candidate("a", { resaleRows: curve([62, 62, 62, 62, 90]) }),
        ),
        projectScoringInput(candidate("b", { resaleRows: [] })),
        projectScoringInput(
          candidate("c", { resaleRows: curve([62, 62, 62, 62, 10]) }),
        ),
      ],
      infra,
    });

    expect(sub(scored[1], "resale").score).toBeNull();
    expect(sub(scored[2], "resale").score).toBe(0);
    expect(scored[1].totalScore).toBeGreaterThan(scored[2].totalScore);
  });
});
