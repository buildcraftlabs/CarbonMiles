import { describe, expect, it } from "vitest";

import { computeOnRoadPrice, type OnRoadFactors } from "./on-road";
import { parseProfile, type RecommendationProfileInput } from "./profile";
import {
  blendedEfficiency,
  breakEvenMonth,
  computeTco,
  interestPaidWithinHorizon,
  selectFinanceRate,
  type EconomicsTables,
  type TcoBreakdown,
  type TcoInput,
  type VariantEconomics,
} from "./tco";

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

/** ₹10L ex-showroom → ₹11,40,600 on-road in Maharashtra. */
const price = computeOnRoadPrice(lakhs(10), MH);

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

const petrolVariant = (over: Partial<VariantEconomics> = {}): VariantEconomics => ({
  variantId: "v1",
  fuelType: "petrol",
  category: "passenger",
  segment: "premium_hatchback",
  exShowroomPaise: lakhs(10),
  realWorldEfficiencyCity: 20,
  realWorldEfficiencyHighway: 25,
  efficiencyUnit: "kmpl",
  batteryKwh: null,
  batteryChemistry: null,
  batteryWarrantyYears: null,
  batteryWarrantyKm: null,
  scheduledServiceCost5yPaise: null,
  ...over,
});

const years = <T>(n: number, f: (year: number) => T) =>
  Array.from({ length: n }, (_, i) => f(i + 1));

const RESIDUALS = [85, 75, 65, 57, 50];

const tables = (over: Partial<EconomicsTables> = {}): EconomicsTables => ({
  /** ₹100/litre, ₹90/kg CNG, ₹8/kWh at a domestic slab. */
  energyPrices: {
    petrol: { pricePaise: 10_000, unit: "litre", asOf: "2026-08-01" },
    cng: { pricePaise: 9_000, unit: "kg", asOf: "2026-08-01" },
    electric: { pricePaise: 800, unit: "kwh", asOf: "2026-08-01" },
  },
  maintenance: years(5, (year) => ({
    segment: "premium_hatchback",
    fuelType: "petrol" as const,
    category: "passenger" as const,
    ownershipYear: year,
    costPaise: 500_000,
    referenceAnnualKm: 12_000,
    marginalCostPaisePerKm: 100,
  })),
  resale: years(5, (year) => ({
    segment: "premium_hatchback",
    fuelType: "petrol" as const,
    category: "passenger" as const,
    ageYears: year,
    residualPct: RESIDUALS[year - 1],
  })),
  batteries: [
    {
      chemistry: "lfp",
      pricePaisePerKwh: 900_000,
      annualDegradationPct: 3,
      replacementThresholdPct: 70,
    },
  ],
  financeRates: [
    {
      category: "passenger",
      fuelType: null,
      annualRatePct: 9,
      processingFeePct: 0.5,
    },
  ],
  discountRatePct: 0,
  ...over,
});

const inputOf = (over: Partial<TcoInput> = {}): TcoInput => ({
  profile: profileOf(),
  price,
  variant: petrolVariant(),
  tables: tables(),
  ...over,
});

const unwrap = (input: TcoInput): TcoBreakdown => {
  const result = computeTco(input);
  if (!result.ok) throw new Error(`${result.code}: ${result.reason}`);
  return result.tco;
};

describe("blendedEfficiency", () => {
  it("weights city and highway by the stated split", () => {
    // 20 kmpl city, 25 highway, 70% city. Over 100 km that is 70/20 + 30/25 =
    // 4.7 L, so 100/4.7 = 21.2766 kmpl — NOT the arithmetic 21.5.
    expect(blendedEfficiency(petrolVariant(), 70)?.value).toBeCloseTo(
      100 / (70 / 20 + 30 / 25),
      6,
    );
  });

  it("never flatters economy the way an arithmetic mean would", () => {
    const harmonic = blendedEfficiency(petrolVariant(), 70)!.value;
    const arithmetic = 20 * 0.7 + 25 * 0.3;
    expect(harmonic).toBeLessThan(arithmetic);
  });

  it("agrees with either mean when the two figures are equal", () => {
    const flat = petrolVariant({
      realWorldEfficiencyCity: 18,
      realWorldEfficiencyHighway: 18,
    });
    expect(blendedEfficiency(flat, 40)?.value).toBeCloseTo(18, 6);
  });

  it("reproduces the fuel actually burned over a mixed route", () => {
    // The property the blend exists to have: distance / blended == litres.
    const blended = blendedEfficiency(petrolVariant(), 70)!.value;
    const litresFromBlend = 1_000 / blended;
    const litresBySegment = 700 / 20 + 300 / 25;
    expect(litresFromBlend).toBeCloseTo(litresBySegment, 9);
  });

  it("falls back to the one published figure, and says which", () => {
    const cityOnly = blendedEfficiency(
      petrolVariant({ realWorldEfficiencyHighway: null }),
      70,
    );
    expect(cityOnly?.value).toBe(20);
    expect(cityOnly?.assumption).toContain("city figure");
  });

  it("returns null when neither is published — nothing is substituted", () => {
    expect(
      blendedEfficiency(
        petrolVariant({
          realWorldEfficiencyCity: null,
          realWorldEfficiencyHighway: null,
        }),
        70,
      ),
    ).toBeNull();
  });
});

describe("computeTco, petrol baseline", () => {
  const tco = unwrap(inputOf());

  it("costs energy from the blended real-world figure", () => {
    // 20 kmpl city / 25 highway at 70% city blends harmonically to
    // 100/4.7 = 21.2766 kmpl, so 14,400 km/yr burns 676.8 l — ₹67,680/yr.
    expect(tco.yearly[0].energyPaise).toBe(6_768_000);
    expect(tco.energyPaise).toBe(6_768_000 * 5);
  });

  it("charges the marginal rate for distance beyond the curve's reference", () => {
    // ₹5,000 base + 2,400 km over the 12,000 km reference at ₹1/km.
    expect(tco.yearly[0].maintenancePaise).toBe(500_000 + 240_000);
  });

  it("does not double-charge first-year insurance, which is in the on-road price", () => {
    expect(tco.yearly[0].insurancePaise).toBe(0);
    // Year 2 renews at 3% of the year-1 residual (85% of ₹10L).
    expect(tco.yearly[1].insurancePaise).toBe(2_550_000);
    expect(tco.insuranceRenewalPaise).toBe(8_460_000);
  });

  it("credits the residual and nets it off the total", () => {
    expect(tco.resaleNominalPaise).toBe(lakhs(5));
    expect(tco.totalPaise).toBe(110_060_000);
    expect(tco.acquisitionPaise).toBe(114_060_000);
  });

  it("reports cost per kilometre over the whole horizon", () => {
    expect(tco.totalKm).toBe(72_000);
    expect(tco.costPaisePerKm).toBeCloseTo(110_060_000 / 72_000, 6);
  });

  it("charges no interest to a cash buyer", () => {
    expect(tco.financingInterestPaise).toBe(0);
    expect(tco.batteryReplacementPaise).toBe(0);
  });

  it("states that prices were held flat, with the date they were held at", () => {
    expect(tco.assumptions.join(" ")).toContain("2026-08-01");
  });

  it("keeps every component in whole paise", () => {
    for (const y of tco.yearly) expect(Number.isInteger(y.totalPaise)).toBe(true);
    expect(Number.isInteger(tco.totalPaise)).toBe(true);
  });
});

describe("computeTco, refusals", () => {
  it("refuses to cost a variant with no real-world efficiency (FR-A7)", () => {
    const result = computeTco(
      inputOf({
        variant: petrolVariant({
          realWorldEfficiencyCity: null,
          realWorldEfficiencyHighway: null,
        }),
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("efficiency_missing");
    expect(result.reason).toContain("ARAI");
  });

  it("refuses when no price is on file for the fuel", () => {
    const result = computeTco(
      inputOf({ tables: tables({ energyPrices: { cng: { pricePaise: 9_000, unit: "kg", asOf: "2026-08-01" } } }) }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("energy_price_missing");
  });

  it("refuses when the segment has no maintenance curve", () => {
    const result = computeTco(
      inputOf({ variant: petrolVariant({ segment: "unknown_segment" }) }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("maintenance_curve_missing");
  });

  it("refuses when the segment has no resale curve", () => {
    const result = computeTco(inputOf({ tables: tables({ resale: [] }) }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("resale_curve_missing");
  });
});

describe("computeTco, manufacturer service package", () => {
  it("overrides the segment curve for the years it covers", () => {
    const tco = unwrap(
      inputOf({
        variant: petrolVariant({ scheduledServiceCost5yPaise: 1_000_000 }),
      }),
    );

    // ₹10,000 across five years, and the curve's marginal km charge does not
    // apply to a fixed-price package.
    expect(tco.yearly[0].maintenancePaise).toBe(200_000);
    expect(tco.maintenancePaise).toBe(1_000_000);
    expect(tco.assumptions.join(" ")).toContain("service package");
  });

  it("returns to the curve once the package runs out", () => {
    const tco = unwrap(
      inputOf({
        profile: profileOf({ ownershipYears: 7 }),
        variant: petrolVariant({ scheduledServiceCost5yPaise: 1_000_000 }),
      }),
    );

    expect(tco.yearly[4].maintenancePaise).toBe(200_000);
    expect(tco.yearly[5].maintenancePaise).toBe(740_000);
    expect(tco.assumptions.join(" ")).toContain("stops at year 5");
  });
});

describe("computeTco, financing", () => {
  const loan = {
    financing: {
      mode: "loan" as const,
      downPaymentPct: 20,
      tenureMonths: 60,
      annualRatePct: 9,
    },
  };

  it("adds interest and a processing fee a cash buyer never pays", () => {
    const cash = unwrap(inputOf());
    const financed = unwrap(inputOf({ profile: profileOf(loan) }));

    expect(financed.financingInterestPaise).toBeGreaterThan(0);
    expect(financed.acquisitionPaise).toBeGreaterThan(cash.acquisitionPaise);
    expect(financed.totalPaise).toBeGreaterThan(cash.totalPaise);
  });

  it("front-loads interest, as a reducing-balance loan does", () => {
    const financed = unwrap(inputOf({ profile: profileOf(loan) }));
    expect(financed.yearly[0].interestPaise).toBeGreaterThan(
      financed.yearly[4].interestPaise,
    );
  });

  it("counts only the interest that falls inside the ownership horizon", () => {
    const shortHold = unwrap(
      inputOf({ profile: profileOf({ ...loan, ownershipYears: 3 }) }),
    );
    const fullTerm = unwrap(inputOf({ profile: profileOf(loan) }));

    expect(shortHold.financingInterestPaise).toBeLessThan(
      fullTerm.financingInterestPaise,
    );
  });

  it("prefers the rate the user supplied over the market average", () => {
    const cheap = unwrap(
      inputOf({ profile: profileOf({ financing: { ...loan.financing, annualRatePct: 7 } }) }),
    );
    const dear = unwrap(
      inputOf({ profile: profileOf({ financing: { ...loan.financing, annualRatePct: 14 } }) }),
    );

    expect(cheap.financingInterestPaise).toBeLessThan(dear.financingInterestPaise);
    expect(cheap.assumptions.join(" ")).toContain("7% rate you supplied");
  });

  it("refuses when neither the user nor the table supplies a rate", () => {
    const result = computeTco(
      inputOf({
        profile: profileOf({
          financing: { mode: "loan", downPaymentPct: 20, tenureMonths: 60 },
        }),
        tables: tables({ financeRates: [] }),
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("finance_rate_missing");
  });
});

describe("interestPaidWithinHorizon", () => {
  it("is zero at a zero rate, however long the tenure", () => {
    expect(interestPaidWithinHorizon(lakhs(8), 0, 60, 60)).toBe(0);
  });

  it("grows with the horizon, then stops at the end of the tenure", () => {
    const p = lakhs(8);
    const atThree = interestPaidWithinHorizon(p, 9, 60, 36);
    const atFive = interestPaidWithinHorizon(p, 9, 60, 60);
    const atSeven = interestPaidWithinHorizon(p, 9, 60, 84);

    expect(atThree).toBeLessThan(atFive);
    expect(atSeven).toBe(atFive);
  });

  it("is zero on a loan of nothing", () => {
    expect(interestPaidWithinHorizon(0, 9, 60, 60)).toBe(0);
  });
});

describe("selectFinanceRate", () => {
  it("prefers a fuel-specific rate over the category default", () => {
    const generic = { category: "passenger" as const, fuelType: null, annualRatePct: 9, processingFeePct: 0.5 };
    const ev = { category: "passenger" as const, fuelType: "electric" as const, annualRatePct: 8, processingFeePct: 0.5 };

    expect(selectFinanceRate([generic, ev], "passenger", "electric")).toBe(ev);
    expect(selectFinanceRate([generic, ev], "passenger", "petrol")).toBe(generic);
  });

  it("returns null when the category has no rate at all", () => {
    expect(selectFinanceRate([], "commercial", "diesel")).toBeNull();
  });
});

describe("computeTco, battery replacement", () => {
  const evTables = (over: Partial<EconomicsTables> = {}) =>
    tables({
      maintenance: years(5, (year) => ({
        segment: "premium_hatchback",
        fuelType: "electric" as const,
        category: "passenger" as const,
        ownershipYear: year,
        costPaise: 300_000,
        referenceAnnualKm: 12_000,
        marginalCostPaisePerKm: 50,
      })),
      resale: years(5, (year) => ({
        segment: "premium_hatchback",
        fuelType: "electric" as const,
        category: "passenger" as const,
        ageYears: year,
        residualPct: RESIDUALS[year - 1],
      })),
      ...over,
    });

  const ev = (over: Partial<VariantEconomics> = {}) =>
    petrolVariant({
      fuelType: "electric",
      realWorldEfficiencyCity: 6,
      realWorldEfficiencyHighway: 5,
      efficiencyUnit: "km/kWh",
      batteryKwh: 40,
      batteryChemistry: "lfp",
      batteryWarrantyYears: 8,
      batteryWarrantyKm: 160_000,
      ...over,
    });

  // At 3%/yr fade the pack reaches 70% at about year 11.7.
  it("charges nothing when the pack outlasts the hold", () => {
    const tco = unwrap(inputOf({ variant: ev(), tables: evTables() }));
    expect(tco.batteryReplacementPaise).toBe(0);
  });

  it("charges the full pack when replacement falls well inside a long hold", () => {
    const tco = unwrap(
      inputOf({
        profile: profileOf({ ownershipYears: 15 }),
        variant: ev(),
        tables: evTables(),
      }),
    );

    expect(tco.batteryReplacementPaise).toBe(40 * 900_000);
    expect(tco.yearly[11].batteryPaise).toBe(40 * 900_000);
  });

  it("charges nothing, and says why, when the warranty still covers it", () => {
    const tco = unwrap(
      inputOf({
        profile: profileOf({ ownershipYears: 15 }),
        variant: ev({ batteryWarrantyYears: 12, batteryWarrantyKm: 200_000 }),
        tables: evTables(),
      }),
    );

    expect(tco.batteryReplacementPaise).toBe(0);
    expect(tco.assumptions.join(" ")).toContain("inside the battery warranty");
  });

  it("tapers the charge when replacement lands near the end of the hold", () => {
    const tco = unwrap(
      inputOf({
        profile: profileOf({ ownershipYears: 13 }),
        variant: ev(),
        tables: evTables(),
      }),
    );

    expect(tco.batteryReplacementPaise).toBeGreaterThan(0);
    expect(tco.batteryReplacementPaise).toBeLessThan(40 * 900_000);
    expect(tco.assumptions.join(" ")).toContain("sell rather than replace");
  });

  it("refuses to cost an EV whose pack chemistry has no price on file", () => {
    const result = computeTco(
      inputOf({
        variant: ev({ batteryChemistry: "solid_state" }),
        tables: evTables(),
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("battery_cost_missing");
  });
});

describe("computeTco, resale discounting", () => {
  it("credits the residual at what it is worth today, not at face value", () => {
    const undiscounted = unwrap(inputOf());
    const discounted = unwrap(
      inputOf({ tables: tables({ discountRatePct: 8 }) }),
    );

    expect(discounted.resaleNominalPaise).toBe(undiscounted.resaleNominalPaise);
    expect(discounted.resaleCreditPaise).toBeLessThan(
      discounted.resaleNominalPaise,
    );
    expect(discounted.totalPaise).toBeGreaterThan(undiscounted.totalPaise);
    expect(discounted.assumptions.join(" ")).toContain("discounted at 8%");
  });

  it("holds the residual flat past the end of the curve rather than extrapolating", () => {
    const tco = unwrap(inputOf({ profile: profileOf({ ownershipYears: 8 }) }));

    expect(tco.resaleNominalPaise).toBe(lakhs(5));
    expect(tco.assumptions.join(" ")).toContain("held flat");
  });
});

describe("breakEvenMonth", () => {
  const tco = (
    acquisitionPaise: number,
    annualRunningPaise: number,
    ownershipYears = 5,
  ): TcoBreakdown => ({
    variantId: "x",
    ownershipYears,
    totalKm: 72_000,
    acquisitionPaise,
    energyPaise: annualRunningPaise * ownershipYears,
    maintenancePaise: 0,
    insuranceRenewalPaise: 0,
    financingInterestPaise: 0,
    batteryReplacementPaise: 0,
    resaleNominalPaise: 0,
    resaleCreditPaise: 0,
    totalPaise: 0,
    costPaisePerKm: 0,
    yearly: years(ownershipYears, (year) => ({
      year,
      energyPaise: annualRunningPaise,
      maintenancePaise: 0,
      insurancePaise: 0,
      interestPaise: 0,
      batteryPaise: 0,
      totalPaise: annualRunningPaise,
    })),
    assumptions: [],
  });

  it("finds the month the dearer, cheaper-to-run vehicle catches up", () => {
    // ₹2L more up front, ₹1L a year cheaper to run -> two years.
    const ev = tco(lakhs(12), lakhs(1));
    const petrol = tco(lakhs(10), lakhs(2));

    expect(breakEvenMonth(ev, petrol)).toBe(24);
  });

  it("returns 0 when the candidate is cheaper from the outset", () => {
    expect(breakEvenMonth(tco(lakhs(9), lakhs(1)), tco(lakhs(10), lakhs(2)))).toBe(0);
  });

  it("returns null when it never catches up inside the horizon", () => {
    const ev = tco(lakhs(20), lakhs(1));
    const petrol = tco(lakhs(10), lakhs(2));

    expect(breakEvenMonth(ev, petrol)).toBeNull();
  });

  it("ignores resale — money the owner has not yet seen cannot break even", () => {
    const withResale = { ...tco(lakhs(20), lakhs(1)), resaleCreditPaise: lakhs(15) };
    const petrol = tco(lakhs(10), lakhs(2));

    expect(breakEvenMonth(withResale, petrol)).toBeNull();
  });
});
