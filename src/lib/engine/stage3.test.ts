import { describe, expect, it } from "vitest";

import type { CandidateVariant, InfraSnapshot } from "./candidate";
import type { Co2Breakdown, EmissionFactor } from "./co2";
import type { CommercialEconomics, CommercialScenario } from "./commercial";
import type { OnRoadFactors, OnRoadPrice } from "./on-road";
import { parseProfile, type RecommendationProfileInput } from "./profile";
import { GATE_THRESHOLDS } from "./stage1";
import {
  BASE_WEIGHTS,
  deriveWeights,
  FIT_PARAMETERS,
  NEUTRAL_SCORE,
  runStage3,
  SCORE_DIMENSIONS,
  type ScoreDimension,
  type ScoredCandidate,
  type ScoringInput,
} from "./stage3";
import type { TcoBreakdown } from "./tco";

const lakhs = (n: number) => Math.round(n * 10_000_000);

const passengerInput: RecommendationProfileInput = {
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

const commercialInput: RecommendationProfileInput = {
  category: "commercial",
  location: { stateCode: "MH" },
  budget: { maxOnRoadPaise: lakhs(20) },
  usage: { dailyKm: 120, monthlyKm: 3120, typicalTripKm: 60, citySharePct: 80 },
  charging: { homeCharging: false },
  preferences: {},
  financing: { mode: "cash" },
  ownershipYears: 5,
  payloadKg: 1000,
  revenuePaisePerKm: 3000,
  driverCostPaisePerMonth: 2_500_000,
};

const passengerProfile = (over: Partial<RecommendationProfileInput> = {}) =>
  parseProfile({ ...passengerInput, ...over } as RecommendationProfileInput);

const commercialProfile = (over: Partial<RecommendationProfileInput> = {}) =>
  parseProfile({ ...commercialInput, ...over } as RecommendationProfileInput);

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

const onRoadFactors: OnRoadFactors = {
  stateCode: "MH",
  category: "passenger",
  fuelType: null,
  priceBandMinPaise: 0,
  priceBandMaxPaise: null,
  roadTaxPct: 11,
  registrationFeePaise: 60_000,
  insurancePct: 3,
  otherLevyPaise: 0,
  effectiveFrom: "2026-04-01",
};

const price = (exShowroomPaise = lakhs(8)): OnRoadPrice => ({
  exShowroomPaise,
  roadTaxPaise: Math.round(exShowroomPaise * 0.11),
  registrationFeePaise: 60_000,
  insurancePaise: Math.round(exShowroomPaise * 0.03),
  otherLevyPaise: 0,
  onRoadPaise: Math.round(exShowroomPaise * 1.14) + 60_000,
  factors: onRoadFactors,
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

const emissionFactor: EmissionFactor = {
  fuelType: "petrol",
  gramsCo2ePerUnit: 2310,
  unit: "litre",
  scope: "well_to_wheel",
  stateCode: null,
  asOf: "2026-04-01",
};

const co2 = (over: Partial<Co2Breakdown> = {}): Co2Breakdown => {
  const gramsCo2ePerKm = over.gramsCo2ePerKm ?? 120;
  return {
    variantId: "v1",
    ownershipYears: 5,
    totalKm: 72_000,
    gramsCo2ePerKm,
    biogenicGramsCo2PerKm: 0,
    annualGramsCo2e: Math.round(gramsCo2ePerKm * 14_400),
    horizonGramsCo2e: Math.round(gramsCo2ePerKm * 72_000),
    horizonBiogenicGramsCo2: 0,
    effectiveEfficiency: 19.25,
    efficiencyUnit: "kmpl",
    appliedGramsCo2ePerUnit: 2310,
    scope: "well_to_wheel",
    factor: emissionFactor,
    blend: null,
    assumptions: [],
    ...over,
  };
};

const scenario = (over: Partial<CommercialScenario> = {}): CommercialScenario => ({
  label: "base",
  revenuePaisePerKm: 3000,
  driverCostPaisePerMonth: 2_500_000,
  grossRevenuePaise: lakhs(56.16),
  driverCostPaise: lakhs(15),
  operatingCostPaise: lakhs(30),
  operatingMarginPaise: lakhs(11.16),
  operatingMarginPctOfRevenue: 19.87,
  netProfitPaise: lakhs(4),
  netMarginPaisePerKm: 200,
  roiPct: 30,
  paybackMonth: 40,
  ...over,
});

const commercial = (
  over: Partial<CommercialEconomics> = {},
): CommercialEconomics => ({
  variantId: "v1",
  ownershipYears: 5,
  totalKm: 187_200,
  capitalPaise: lakhs(13),
  kmPerOperatingDay: 120,
  base: scenario(),
  low: scenario({ label: "low", netMarginPaisePerKm: 40, paybackMonth: 55 }),
  high: scenario({ label: "high", netMarginPaisePerKm: 360, paybackMonth: 28 }),
  operatingMarginStraddlesZero: false,
  netProfitStraddlesZero: false,
  sensitivity: { revenueSwingPct: 20, driverCostSwingPct: 12 },
  sensitivitySource: "duty_cycle_default",
  assumptions: [],
  ...over,
});

const entry = (over: Partial<ScoringInput> = {}): ScoringInput => ({
  variant: variant(),
  price: price(),
  tco: tco(),
  co2: co2(),
  commercial: null,
  serviceCentreCount: 1500,
  resaleLiquidityScore: 70,
  ...over,
});

const infra: InfraSnapshot = {
  petrol: { type: "petrol", stationCount: 900, percentile: 80, confidenceScore: 90 },
  ev_dc: { type: "ev_dc", stationCount: 120, percentile: 70, confidenceScore: 80 },
  cng: { type: "cng", stationCount: 200, percentile: 60, confidenceScore: 75 },
};

const sub = (candidate: ScoredCandidate, dimension: ScoreDimension) => {
  const found = candidate.subScores.find((s) => s.dimension === dimension);
  if (found === undefined) throw new Error(`no ${dimension} sub-score`);
  return found;
};

describe("deriveWeights", () => {
  it("normalises the passenger persona to sum to one", () => {
    const { weights } = deriveWeights(passengerProfile());
    const total = Object.values(weights).reduce((sum, w) => sum + (w ?? 0), 0);

    expect(total).toBeCloseTo(1, 3);
    expect(weights.cost).toBeGreaterThan(weights.usage ?? 0);
    expect(weights.profitability).toBeUndefined();
    expect(weights.payback).toBeUndefined();
  });

  it("weights CO2 as a share of the money weight, per the preference's meaning", () => {
    const quarter = deriveWeights(
      passengerProfile({ preferences: { environmentWeight: 0.25 } }),
    ).weights;

    expect(quarter.environment).toBeCloseTo((quarter.cost ?? 0) * 0.25, 4);
  });

  it("weights CO2 exactly as heavily as money at a preference of 1", () => {
    const { weights } = deriveWeights(
      passengerProfile({ preferences: { environmentWeight: 1 } }),
    );

    expect(weights.environment).toBeCloseTo(weights.cost ?? 0, 4);
  });

  it("drops the environment dimension entirely at a preference of zero", () => {
    const { weights, basis } = deriveWeights(
      passengerProfile({ preferences: { environmentWeight: 0 } }),
    );

    expect(weights.environment).toBeUndefined();
    expect(basis.join(" ")).toContain("not scored at all");
  });

  it("gives a commercial profile profitability and payback, and no separate cost", () => {
    const { weights } = deriveWeights(commercialProfile());
    const total = Object.values(weights).reduce((sum, w) => sum + (w ?? 0), 0);

    expect(total).toBeCloseTo(1, 3);
    expect(weights.cost).toBeUndefined();
    expect(weights.profitability).toBeDefined();
    expect(weights.payback).toBeDefined();
  });

  it("weights profitability hardest of all dimensions for a commercial buyer", () => {
    const { weights } = deriveWeights(commercialProfile());
    const others = SCORE_DIMENSIONS.filter((d) => d !== "profitability").map(
      (d) => weights[d] ?? 0,
    );

    expect(weights.profitability).toBeGreaterThan(Math.max(...others));
  });

  it("scales the commercial CO2 weight against profitability and payback together", () => {
    const { weights } = deriveWeights(
      commercialProfile({ preferences: { environmentWeight: 1 } }),
    );

    // Compared at three places: the two money weights are each rounded to four
    // before being added, so their sum carries twice the rounding error the
    // single environment weight does.
    expect(weights.environment).toBeCloseTo(
      (weights.profitability ?? 0) + (weights.payback ?? 0),
      3,
    );
  });

  it("keeps the base weight tables summing to one before derivation", () => {
    for (const category of ["passenger", "commercial"] as const) {
      const total = Object.values(BASE_WEIGHTS[category]).reduce(
        (sum, w) => sum + (w ?? 0),
        0,
      );
      expect(total).toBeCloseTo(1, 6);
    }
  });
});

describe("runStage3 normalisation", () => {
  const cheap = entry({
    variant: variant({ variantId: "cheap", name: "Cheap" }),
    tco: tco({ variantId: "cheap", totalPaise: lakhs(10) }),
  });
  const mid = entry({
    variant: variant({ variantId: "mid", name: "Mid" }),
    tco: tco({ variantId: "mid", totalPaise: lakhs(12) }),
  });
  const dear = entry({
    variant: variant({ variantId: "dear", name: "Dear" }),
    tco: tco({ variantId: "dear", totalPaise: lakhs(14) }),
  });

  it("puts the cheapest at 100 and the dearest at 0 on cost", () => {
    const { scored } = runStage3({
      profile: passengerProfile(),
      candidates: [cheap, mid, dear],
      infra,
    });

    expect(sub(scored[0], "cost").score).toBe(100);
    expect(sub(scored[2], "cost").score).toBe(0);
    expect(sub(scored[1], "cost").score).toBe(50);
  });

  it("carries the range each score was measured against", () => {
    const { scored } = runStage3({
      profile: passengerProfile(),
      candidates: [cheap, mid, dear],
      infra,
    });

    expect(sub(scored[1], "cost").range).toEqual({
      min: lakhs(10),
      max: lakhs(14),
    });
    expect(sub(scored[1], "cost").raw).toBe(lakhs(12));
    expect(sub(scored[1], "cost").direction).toBe("lower_is_better");
  });

  it("returns candidates in input order — ranking is stage 4's job", () => {
    const { scored } = runStage3({
      profile: passengerProfile(),
      candidates: [dear, cheap, mid],
      infra,
    });

    expect(scored.map((s) => s.variantId)).toEqual(["dear", "cheap", "mid"]);
  });

  it("keeps every total inside 0–100 with weights summing to one", () => {
    const { scored } = runStage3({
      profile: passengerProfile(),
      candidates: [cheap, mid, dear],
      infra,
    });

    for (const candidate of scored) {
      expect(candidate.totalScore).toBeGreaterThanOrEqual(0);
      expect(candidate.totalScore).toBeLessThanOrEqual(100);
      const applied = candidate.subScores.reduce((sum, s) => sum + s.weight, 0);
      expect(applied).toBeCloseTo(1, 2);
    }
  });

  it("scores a tied dimension neutral and marks it non-discriminating", () => {
    const { scored, assumptions } = runStage3({
      profile: passengerProfile(),
      candidates: [cheap, mid, dear],
      infra,
    });

    // Every fixture carries 1500 service centres and a liquidity score of 70.
    for (const candidate of scored) {
      expect(sub(candidate, "reliability").score).toBe(NEUTRAL_SCORE);
      expect(sub(candidate, "reliability").discriminating).toBe(false);
      expect(sub(candidate, "resale").discriminating).toBe(false);
    }
    expect(assumptions.join(" ")).toContain("could not separate them");
  });

  it("scores a lone candidate neutral rather than perfect", () => {
    const { scored, assumptions } = runStage3({
      profile: passengerProfile(),
      candidates: [mid],
      infra,
    });

    expect(scored[0].totalScore).toBe(NEUTRAL_SCORE);
    expect(assumptions.join(" ")).toContain("Only one vehicle survived");
  });
});

describe("runStage3 environment sub-score", () => {
  it("normalises on counted grams and ignores biogenic carbon entirely", () => {
    const dirty = entry({
      variant: variant({ variantId: "dirty", name: "Dirty" }),
      co2: co2({ variantId: "dirty", gramsCo2ePerKm: 160 }),
    });
    // Same counted figure, wildly different biogenic figure. If biogenic were
    // folded in, these two would not tie.
    const blended = entry({
      variant: variant({ variantId: "blended", name: "Blended" }),
      co2: co2({
        variantId: "blended",
        gramsCo2ePerKm: 160,
        biogenicGramsCo2PerKm: 45,
        horizonBiogenicGramsCo2: 45 * 72_000,
      }),
    });

    const { scored } = runStage3({
      profile: passengerProfile(),
      candidates: [dirty, blended],
      infra,
    });

    expect(sub(scored[0], "environment").score).toBe(
      sub(scored[1], "environment").score,
    );
    expect(sub(scored[0], "environment").raw).toBe(160);
    expect(sub(scored[1], "environment").raw).toBe(160);
  });

  it("puts the cleaner vehicle ahead on environment", () => {
    const clean = entry({
      variant: variant({ variantId: "clean", name: "Clean" }),
      co2: co2({ variantId: "clean", gramsCo2ePerKm: 80 }),
    });
    const dirty = entry({
      variant: variant({ variantId: "dirty", name: "Dirty" }),
      co2: co2({ variantId: "dirty", gramsCo2ePerKm: 160 }),
    });

    const { scored } = runStage3({
      profile: passengerProfile(),
      candidates: [clean, dirty],
      infra,
    });

    expect(sub(scored[0], "environment").score).toBe(100);
    expect(sub(scored[1], "environment").score).toBe(0);
  });
});

describe("runStage3 missing data", () => {
  const known = entry({
    variant: variant({ variantId: "known", name: "Known" }),
    tco: tco({ variantId: "known", totalPaise: lakhs(10) }),
    serviceCentreCount: 2000,
  });
  const unknown = entry({
    variant: variant({ variantId: "unknown", name: "Unknown" }),
    tco: tco({ variantId: "unknown", totalPaise: lakhs(12) }),
    serviceCentreCount: null,
  });

  it("leaves the dimension null rather than imputing a midpoint", () => {
    const { scored } = runStage3({
      profile: passengerProfile(),
      candidates: [known, unknown],
      infra,
    });

    expect(sub(scored[1], "reliability").score).toBeNull();
    expect(sub(scored[1], "reliability").raw).toBeNull();
    expect(sub(scored[1], "reliability").weight).toBe(0);
    expect(scored[1].unscored.map((u) => u.dimension)).toEqual(["reliability"]);
  });

  it("redistributes the missing weight so the total is not quietly shrunk", () => {
    const { scored } = runStage3({
      profile: passengerProfile(),
      candidates: [known, unknown],
      infra,
    });

    const applied = scored[1].subScores.reduce((sum, s) => sum + s.weight, 0);
    expect(applied).toBeCloseTo(1, 2);
    // Cost carries more of the decision precisely because reliability could not.
    expect(sub(scored[1], "cost").weight).toBeGreaterThan(
      sub(scored[0], "cost").weight,
    );
  });

  it("says in the assumptions which vehicle lost which dimension and why", () => {
    const { assumptions } = runStage3({
      profile: passengerProfile(),
      candidates: [known, unknown],
      infra,
    });

    expect(assumptions.join(" ")).toContain("Unknown was not scored on reliability");
    expect(assumptions.join(" ")).toContain("service-centre count");
  });

  it("does not penalise the vehicle with the gap on its total", () => {
    // Identical on everything scoreable; one simply has no service data.
    const twinKnown = entry({
      variant: variant({ variantId: "a", name: "A" }),
      serviceCentreCount: 1500,
    });
    const twinUnknown = entry({
      variant: variant({ variantId: "b", name: "B" }),
      serviceCentreCount: null,
    });

    const { scored } = runStage3({
      profile: passengerProfile(),
      candidates: [twinKnown, twinUnknown],
      infra,
    });

    expect(scored[0].totalScore).toBe(scored[1].totalScore);
  });

  it("leaves environment unscored where no emission factor covered the fuel", () => {
    const { scored } = runStage3({
      profile: passengerProfile(),
      candidates: [known, entry({ ...unknown, co2: null })],
      infra,
    });

    expect(sub(scored[1], "environment").score).toBeNull();
    expect(sub(scored[1], "environment").note).toContain("no emission factor");
  });
});

describe("runStage3 usage suitability", () => {
  it("penalises surplus seats without disqualifying them", () => {
    const exact = entry({
      variant: variant({ variantId: "five", name: "Five", seatingCapacity: 5 }),
    });
    const surplus = entry({
      variant: variant({ variantId: "seven", name: "Seven", seatingCapacity: 7 }),
    });

    const { scored } = runStage3({
      profile: passengerProfile(),
      candidates: [exact, surplus],
      infra,
    });

    expect(sub(scored[0], "usage").raw).toBe(100);
    expect(sub(scored[1], "usage").raw).toBe(
      100 - 2 * FIT_PARAMETERS.seatSurplusPenalty,
    );
    expect(sub(scored[1], "usage").raw).toBeGreaterThanOrEqual(
      FIT_PARAMETERS.capacityFitFloor,
    );
  });

  it("floors the capacity penalty however far over-specified the vehicle is", () => {
    const absurd = entry({
      variant: variant({ variantId: "bus", name: "Bus", seatingCapacity: 9 }),
    });
    const { scored } = runStage3({
      profile: passengerProfile({ passengers: 1 }),
      candidates: [absurd],
      infra,
    });

    expect(sub(scored[0], "usage").raw).toBe(FIT_PARAMETERS.capacityFitFloor);
  });

  it("scores range headroom for an electric vehicle and says so", () => {
    // 40 km between charges; 400 km real-world range is 320 km usable, a ratio
    // well past the comfortable threshold, so range scores full marks.
    const ev = entry({
      variant: variant({
        variantId: "ev",
        name: "EV",
        fuelType: "electric",
        realWorldRangeKm: 400,
      }),
    });

    const { scored } = runStage3({
      profile: passengerProfile(),
      candidates: [ev],
      infra,
    });

    expect(sub(scored[0], "usage").raw).toBe(100);
    expect(sub(scored[0], "usage").note).toContain("Range");
  });

  it("marks down an electric vehicle that only just clears the range gate", () => {
    // Usable range exactly equals the distance between charges.
    const justEnough = Math.round(40 / GATE_THRESHOLDS.evRangeUtilisation);
    const ev = entry({
      variant: variant({
        variantId: "ev",
        name: "EV",
        fuelType: "electric",
        realWorldRangeKm: justEnough,
      }),
    });

    const { scored } = runStage3({
      profile: passengerProfile(),
      candidates: [ev],
      infra,
    });

    // Capacity is a perfect 100, range is the adequate-but-no-more score.
    expect(sub(scored[0], "usage").raw).toBeCloseTo(
      (100 + FIT_PARAMETERS.adequateRangeScore) / 2,
      1,
    );
  });

  it("does not score range for a liquid-fuel vehicle", () => {
    const petrol = entry({
      variant: variant({ variantId: "p", name: "P", realWorldRangeKm: 600 }),
    });

    const { scored } = runStage3({
      profile: passengerProfile(),
      candidates: [petrol],
      infra,
    });

    expect(sub(scored[0], "usage").raw).toBe(100);
    expect(sub(scored[0], "usage").note).toContain("Capacity fit —");
    expect(sub(scored[0], "usage").note).not.toContain("Range");
  });

  it("scores payload headroom for a commercial buyer", () => {
    const right = entry({
      variant: variant({
        variantId: "right",
        name: "Right",
        category: "commercial",
        bodyType: "pickup",
        seatingCapacity: 2,
        payloadKg: 1000,
      }),
      commercial: commercial({ variantId: "right" }),
    });
    const oversized = entry({
      variant: variant({
        variantId: "big",
        name: "Big",
        category: "commercial",
        bodyType: "pickup",
        seatingCapacity: 2,
        payloadKg: 2000,
      }),
      commercial: commercial({ variantId: "big" }),
    });

    const { scored } = runStage3({
      profile: commercialProfile(),
      candidates: [right, oversized],
      infra,
    });

    expect(sub(scored[0], "usage").raw).toBe(100);
    expect(sub(scored[1], "usage").raw).toBe(
      100 - FIT_PARAMETERS.payloadSurplusPenalty,
    );
    expect(sub(scored[1], "usage").note).toContain("2000 kg payload");
  });
});

describe("runStage3 infrastructure sub-score", () => {
  it("discounts a density percentile toward neutral by its source confidence", () => {
    const thin: InfraSnapshot = {
      cng: { type: "cng", stationCount: 40, percentile: 20, confidenceScore: 50 },
    };
    const cng = entry({
      variant: variant({ variantId: "cng", name: "CNG", fuelType: "cng" }),
    });

    const { scored } = runStage3({
      profile: passengerProfile(),
      candidates: [cng],
      infra: thin,
    });

    // 50 + (20 - 50) * 0.5 = 35: a poor reading we half-trust, pulled halfway back.
    expect(sub(scored[0], "infrastructure").raw).toBe(35);
  });

  it("puts a floor under an electric vehicle when the buyer charges at home", () => {
    const sparse: InfraSnapshot = {
      ev_dc: { type: "ev_dc", stationCount: 3, percentile: 15, confidenceScore: 90 },
    };
    const ev = entry({
      variant: variant({
        variantId: "ev",
        name: "EV",
        fuelType: "electric",
        realWorldRangeKm: 400,
      }),
    });

    const { scored } = runStage3({
      profile: passengerProfile({ charging: { homeCharging: true } }),
      candidates: [ev],
      infra: sparse,
    });

    expect(sub(scored[0], "infrastructure").raw).toBe(
      FIT_PARAMETERS.homeChargingFloor,
    );
    expect(sub(scored[0], "infrastructure").note).toContain("charge at home");
  });

  it("leaves an electric vehicle exposed to the public network without home charging", () => {
    const sparse: InfraSnapshot = {
      ev_dc: { type: "ev_dc", stationCount: 30, percentile: 30, confidenceScore: 100 },
    };
    const ev = entry({
      variant: variant({
        variantId: "ev",
        name: "EV",
        fuelType: "electric",
        realWorldRangeKm: 400,
      }),
    });

    const { scored } = runStage3({
      profile: passengerProfile({ charging: { homeCharging: false } }),
      candidates: [ev],
      infra: sparse,
    });

    expect(sub(scored[0], "infrastructure").raw).toBe(30);
  });

  it("falls back to the AC network when no DC reading exists", () => {
    const acOnly: InfraSnapshot = {
      ev_ac: { type: "ev_ac", stationCount: 60, percentile: 40, confidenceScore: 100 },
    };
    const ev = entry({
      variant: variant({
        variantId: "ev",
        name: "EV",
        fuelType: "electric",
        realWorldRangeKm: 400,
      }),
    });

    const { scored } = runStage3({
      profile: passengerProfile({ charging: { homeCharging: false } }),
      candidates: [ev],
      infra: acOnly,
    });

    expect(sub(scored[0], "infrastructure").raw).toBe(40);
  });

  it("scores petrol on the near-universal network when no reading exists", () => {
    const { scored } = runStage3({
      profile: passengerProfile(),
      candidates: [entry()],
      infra: {},
    });

    expect(sub(scored[0], "infrastructure").raw).toBe(
      FIT_PARAMETERS.ubiquitousFuelScore,
    );
  });

  it("leaves LPG unscored rather than assuming a network we do not track", () => {
    const lpg = entry({
      variant: variant({ variantId: "lpg", name: "LPG", fuelType: "lpg" }),
    });

    const { scored } = runStage3({
      profile: passengerProfile(),
      candidates: [lpg, entry()],
      infra,
    });

    expect(sub(scored[0], "infrastructure").score).toBeNull();
    expect(sub(scored[0], "infrastructure").note).toContain("no lpg infrastructure");
  });
});

describe("runStage3 commercial", () => {
  const commercialVariant = (id: string, name: string) =>
    variant({
      variantId: id,
      name,
      category: "commercial",
      bodyType: "pickup",
      seatingCapacity: 2,
      payloadKg: 1000,
    });

  const earner = entry({
    variant: commercialVariant("earner", "Earner"),
    tco: tco({ variantId: "earner", totalPaise: lakhs(28), totalKm: 187_200 }),
    commercial: commercial({
      variantId: "earner",
      base: scenario({ netMarginPaisePerKm: 300, paybackMonth: 30 }),
    }),
  });

  const laggard = entry({
    variant: commercialVariant("laggard", "Laggard"),
    tco: tco({ variantId: "laggard", totalPaise: lakhs(34), totalKm: 187_200 }),
    commercial: commercial({
      variantId: "laggard",
      base: scenario({ netMarginPaisePerKm: 100, paybackMonth: 52 }),
    }),
  });

  it("scores profitability and payback, and never a separate cost dimension", () => {
    const { scored } = runStage3({
      profile: commercialProfile(),
      candidates: [earner, laggard],
      infra,
    });

    expect(sub(scored[0], "profitability").score).toBe(100);
    expect(sub(scored[1], "profitability").score).toBe(0);
    expect(sub(scored[0], "payback").score).toBe(100);
    expect(
      scored[0].subScores.some((s) => s.dimension === "cost"),
    ).toBe(false);
  });

  it("scores a vehicle that never pays back one month past the horizon", () => {
    const never = entry({
      variant: commercialVariant("never", "Never"),
      commercial: commercial({
        variantId: "never",
        base: scenario({ netMarginPaisePerKm: 20, paybackMonth: null }),
      }),
    });

    const { scored } = runStage3({
      profile: commercialProfile(),
      candidates: [earner, never],
      infra,
    });

    expect(sub(scored[1], "payback").raw).toBe(61);
    expect(sub(scored[1], "payback").score).toBe(0);
    expect(sub(scored[1], "payback").note).toContain("does not pay back");
  });

  it("puts the profitable vehicle ahead overall", () => {
    const { scored } = runStage3({
      profile: commercialProfile(),
      candidates: [earner, laggard],
      infra,
    });

    expect(scored[0].totalScore).toBeGreaterThan(scored[1].totalScore);
  });

  it("leaves profitability and payback unscored when the economics failed", () => {
    const broken = entry({
      variant: commercialVariant("broken", "Broken"),
      commercial: null,
    });

    const { scored } = runStage3({
      profile: commercialProfile(),
      candidates: [earner, broken],
      infra,
    });

    expect(sub(scored[1], "profitability").score).toBeNull();
    expect(sub(scored[1], "payback").score).toBeNull();
    const applied = scored[1].subScores.reduce((sum, s) => sum + s.weight, 0);
    expect(applied).toBeCloseTo(1, 2);
  });
});

describe("runStage3 determinism and explainability", () => {
  const candidates = [
    entry({
      variant: variant({ variantId: "a", name: "A" }),
      tco: tco({ variantId: "a", totalPaise: lakhs(10) }),
      serviceCentreCount: 2000,
      resaleLiquidityScore: 80,
    }),
    entry({
      variant: variant({ variantId: "b", name: "B", seatingCapacity: 7 }),
      tco: tco({ variantId: "b", totalPaise: lakhs(13) }),
      co2: co2({ variantId: "b", gramsCo2ePerKm: 150 }),
      serviceCentreCount: 400,
      resaleLiquidityScore: 45,
    }),
  ];

  it("returns identical results for identical input", () => {
    const profile = passengerProfile();
    const first = runStage3({ profile, candidates, infra });
    const second = runStage3({ profile, candidates, infra });

    expect(first).toEqual(second);
  });

  it("carries a weight, a range and a raw figure for every scored dimension", () => {
    const { scored } = runStage3({
      profile: passengerProfile(),
      candidates,
      infra,
    });

    for (const candidate of scored) {
      for (const subScore of candidate.subScores) {
        if (subScore.score === null) continue;
        expect(subScore.raw).not.toBeNull();
        expect(subScore.range).not.toBeNull();
        expect(subScore.weight).toBeGreaterThan(0);
        expect(subScore.unit.length).toBeGreaterThan(0);
      }
    }
  });

  it("returns the persona weights alongside the scores", () => {
    const { weights, weightBasis } = runStage3({
      profile: passengerProfile(),
      candidates,
      infra,
    });

    expect(weights.cost).toBeDefined();
    expect(weightBasis.join(" ")).toContain("cost of ownership");
  });

  it("moves the ranking when the environmental preference does", () => {
    const moneyOnly = runStage3({
      profile: passengerProfile({ preferences: { environmentWeight: 0 } }),
      candidates,
      infra,
    });
    const greenest = runStage3({
      profile: passengerProfile({ preferences: { environmentWeight: 1 } }),
      candidates,
      infra,
    });

    // B is dearer and dirtier, so weighting CO2 harder can only widen the gap.
    const moneyGap = moneyOnly.scored[0].totalScore - moneyOnly.scored[1].totalScore;
    const greenGap = greenest.scored[0].totalScore - greenest.scored[1].totalScore;
    expect(greenGap).toBeGreaterThan(moneyGap);
  });
});
