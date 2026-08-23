import { describe, expect, it } from "vitest";

import {
  computeCommercialEconomics,
  DEFAULT_SENSITIVITY_BY_DUTY_CYCLE,
  paybackMonth,
  type CommercialEconomics,
  type CommercialInput,
} from "./commercial";
import { computeOnRoadPrice, type OnRoadFactors } from "./on-road";
import { commercialProfileSchema, type CommercialProfile } from "./profile";
import {
  computeTco,
  type EconomicsTables,
  type TcoBreakdown,
  type VariantEconomics,
} from "./tco";

const lakhs = (n: number) => Math.round(n * 10_000_000);

/**
 * A ₹20/km freight rate, a ₹25,000/month driver, 5,000 km a month over five
 * years — 300,000 km, which is what the cost fixture below is costed over.
 */
const profileInput = {
  category: "commercial" as const,
  location: { stateCode: "MH" },
  budget: { maxOnRoadPaise: lakhs(15) },
  usage: { dailyKm: 200, monthlyKm: 5_000, typicalTripKm: 200, citySharePct: 30 },
  charging: { homeCharging: false },
  preferences: {},
  financing: { mode: "cash" as const },
  ownershipYears: 5,
  payloadKg: 1_500,
  revenuePaisePerKm: 2_000,
  driverCostPaisePerMonth: 2_500_000,
  dutyCycle: "mixed" as const,
  operatingDaysPerMonth: 25,
};

const profileOf = (
  over: Record<string, unknown> = {},
): CommercialProfile =>
  commercialProfileSchema.parse({ ...profileInput, ...over });

interface BreakdownOver {
  ownershipYears?: number;
  totalKm?: number;
  acquisitionPaise?: number;
  annualRunningPaise?: number;
  resaleCreditPaise?: number;
}

/**
 * A deliberately round cost breakdown, so every expectation below is a number
 * that can be checked by hand: ₹8L to buy, ₹2L a year to run, ₹2L back at the
 * end, 300,000 km over five years.
 */
const breakdown = ({
  ownershipYears = 5,
  totalKm = 300_000,
  acquisitionPaise = lakhs(8),
  annualRunningPaise = lakhs(2),
  resaleCreditPaise = lakhs(2),
}: BreakdownOver = {}): TcoBreakdown => {
  const yearly = Array.from({ length: ownershipYears }, (_, i) => ({
    year: i + 1,
    energyPaise: annualRunningPaise,
    maintenancePaise: 0,
    insurancePaise: 0,
    interestPaise: 0,
    batteryPaise: 0,
    totalPaise: annualRunningPaise,
  }));
  const totalPaise =
    acquisitionPaise + annualRunningPaise * ownershipYears - resaleCreditPaise;

  return {
    variantId: "cv1",
    ownershipYears,
    totalKm,
    acquisitionPaise,
    energyPaise: annualRunningPaise * ownershipYears,
    maintenancePaise: 0,
    insuranceRenewalPaise: 0,
    financingInterestPaise: 0,
    batteryReplacementPaise: 0,
    resaleNominalPaise: resaleCreditPaise,
    resaleCreditPaise,
    totalPaise,
    costPaisePerKm: totalKm > 0 ? totalPaise / totalKm : 0,
    yearly,
    assumptions: [],
  };
};

const inputOf = (over: Partial<CommercialInput> = {}): CommercialInput => ({
  profile: profileOf(),
  tco: breakdown(),
  ...over,
});

const unwrap = (input: CommercialInput): CommercialEconomics => {
  const result = computeCommercialEconomics(input);
  if (!result.ok) throw new Error(`${result.code}: ${result.reason}`);
  return result.economics;
};

describe("computeCommercialEconomics, base case", () => {
  const economics = unwrap(inputOf());

  it("earns the stated rate over every kilometre the TCO was costed on", () => {
    // ₹20/km over 300,000 km = ₹60L.
    expect(economics.totalKm).toBe(300_000);
    expect(economics.base.grossRevenuePaise).toBe(600_000_000);
  });

  it("charges the driver for every month of the horizon", () => {
    // ₹25,000 a month for 60 months = ₹15L.
    expect(economics.base.driverCostPaise).toBe(150_000_000);
    // ₹10L of running cost plus the driver.
    expect(economics.base.operatingCostPaise).toBe(250_000_000);
  });

  it("takes the operating margin above running cost, before capital", () => {
    expect(economics.base.operatingMarginPaise).toBe(350_000_000);
    expect(economics.base.operatingMarginPctOfRevenue).toBeCloseTo(58.333, 3);
  });

  it("takes net profit after the vehicle itself, net of the residual", () => {
    // ₹60L earned, less ₹16L of TCO (₹8L + ₹10L - ₹2L back) and ₹15L of driver.
    expect(economics.base.netProfitPaise).toBe(290_000_000);
    expect(economics.base.netMarginPaisePerKm).toBeCloseTo(966.667, 3);
  });

  it("measures ROI against the capital committed to buy the vehicle", () => {
    expect(economics.capitalPaise).toBe(lakhs(8));
    expect(economics.base.roiPct).toBeCloseTo(362.5, 6);
  });

  it("reports the distance per operating day for the operator to sanity-check", () => {
    // 5,000 km across 25 days.
    expect(economics.kmPerOperatingDay).toBe(200);
  });

  it("keeps every money figure a whole number of paise", () => {
    for (const scenario of [economics.low, economics.base, economics.high]) {
      expect(Number.isSafeInteger(scenario.grossRevenuePaise)).toBe(true);
      expect(Number.isSafeInteger(scenario.driverCostPaise)).toBe(true);
      expect(Number.isSafeInteger(scenario.operatingMarginPaise)).toBe(true);
      expect(Number.isSafeInteger(scenario.netProfitPaise)).toBe(true);
      expect(Number.isSafeInteger(scenario.revenuePaisePerKm)).toBe(true);
      expect(Number.isSafeInteger(scenario.driverCostPaisePerMonth)).toBe(true);
    }
  });

  it("holds together at truck money, well past int32", () => {
    // ₹100/km over 1.2M km against a ₹50L truck: ₹12cr of revenue, in paise.
    const economics = unwrap(
      inputOf({
        profile: profileOf({
          usage: {
            dailyKm: 800,
            monthlyKm: 20_000,
            typicalTripKm: 800,
            citySharePct: 10,
          },
          revenuePaisePerKm: 10_000,
          budget: { maxOnRoadPaise: lakhs(80) },
        }),
        tco: breakdown({
          totalKm: 1_200_000,
          acquisitionPaise: lakhs(50),
          annualRunningPaise: lakhs(12),
          resaleCreditPaise: lakhs(10),
        }),
      }),
    );

    expect(economics.base.grossRevenuePaise).toBe(12_000_000_000);
    expect(economics.base.grossRevenuePaise).toBeGreaterThan(2_147_483_647);
    expect(Number.isSafeInteger(economics.base.netProfitPaise)).toBe(true);
  });
});

describe("driver cost", () => {
  it("is subtracted from both margins, at its full monthly rate", () => {
    const paid = unwrap(inputOf());
    const ownerDriven = unwrap(
      inputOf({ profile: profileOf({ driverCostPaisePerMonth: 0 }) }),
    );

    // Exactly ₹25,000 x 60 months of difference, nothing else moved.
    expect(ownerDriven.base.operatingMarginPaise - paid.base.operatingMarginPaise).toBe(
      150_000_000,
    );
    expect(ownerDriven.base.netProfitPaise - paid.base.netProfitPaise).toBe(
      150_000_000,
    );
  });

  it("treats zero as an owner-driver, not as a missing figure", () => {
    const economics = unwrap(
      inputOf({ profile: profileOf({ driverCostPaisePerMonth: 0 }) }),
    );

    expect(economics.base.driverCostPaise).toBe(0);
    expect(economics.base.operatingCostPaise).toBe(100_000_000);
    expect(economics.assumptions.join(" ")).toContain("owner-driven");
  });

  it("narrows the band to the freight rate alone for an owner-driver", () => {
    const ownerDriven = unwrap(
      inputOf({ profile: profileOf({ driverCostPaisePerMonth: 0 }) }),
    );
    const paid = unwrap(inputOf());

    expect(ownerDriven.low.driverCostPaisePerMonth).toBe(0);
    expect(ownerDriven.high.driverCostPaisePerMonth).toBe(0);

    const width = (e: CommercialEconomics) =>
      e.high.netProfitPaise - e.low.netProfitPaise;
    expect(width(ownerDriven)).toBeLessThan(width(paid));
  });
});

describe("paybackMonth", () => {
  it("finds the month cumulative earnings overtake cumulative spend", () => {
    // ₹10L/month earned against ₹8L up front plus ₹4.17L/month of cost.
    expect(unwrap(inputOf()).base.paybackMonth).toBe(14);
    expect(paybackMonth(breakdown(), 2_000, 2_500_000)).toBe(14);
  });

  it("does not pay back a month earlier than the money allows", () => {
    // At month 13 the operator is still ₹4.17L short; the boundary matters
    // because this is the number a fleet buyer plans a loan around.
    const tco = breakdown();
    const revenuePerMonth = (2_000 * tco.totalKm) / 60;
    const spendAt13 =
      tco.acquisitionPaise + 2_500_000 * 13 + (lakhs(2) * 13) / 12;
    expect(revenuePerMonth * 13).toBeLessThan(spendAt13);
  });

  it("pays back later as the driver costs more", () => {
    const cheap = paybackMonth(breakdown(), 2_000, 1_000_000);
    const dear = paybackMonth(breakdown(), 2_000, 4_000_000);

    expect(cheap).not.toBeNull();
    expect(dear).not.toBeNull();
    expect(cheap as number).toBeLessThan(dear as number);
  });

  it("returns null when it never pays back inside the horizon", () => {
    // ₹10/km: earnings never catch the cost curve within five years.
    const economics = unwrap(
      inputOf({ profile: profileOf({ revenuePaisePerKm: 1_000 }) }),
    );

    expect(economics.base.paybackMonth).toBeNull();
    expect(paybackMonth(breakdown(), 1_000, 2_500_000)).toBeNull();
  });

  it("ignores the resale credit — money the operator has not yet seen", () => {
    const modest = inputOf({ tco: breakdown({ resaleCreditPaise: lakhs(2) }) });
    const generous = inputOf({ tco: breakdown({ resaleCreditPaise: lakhs(6) }) });

    expect(unwrap(generous).base.paybackMonth).toBe(
      unwrap(modest).base.paybackMonth,
    );
    // But it is credited in the whole-horizon figures.
    expect(unwrap(generous).base.netProfitPaise).toBe(
      unwrap(modest).base.netProfitPaise + lakhs(4),
    );
  });

  it("returns null rather than zero when there are no kilometres to earn on", () => {
    expect(paybackMonth(breakdown({ totalKm: 0 }), 2_000, 0)).toBeNull();
  });
});

describe("the sensitivity band", () => {
  const economics = unwrap(inputOf());

  it("moves the freight rate both ways by the stated swing", () => {
    // "mixed" defaults to ±20% on the rate.
    expect(economics.base.revenuePaisePerKm).toBe(2_000);
    expect(economics.low.revenuePaisePerKm).toBe(1_600);
    expect(economics.high.revenuePaisePerKm).toBe(2_400);
  });

  it("pairs the inputs adversely: the low case is the worst of both", () => {
    // ±12% on driver pay, moved *against* the rate, not with it.
    expect(economics.low.driverCostPaisePerMonth).toBe(2_800_000);
    expect(economics.high.driverCostPaisePerMonth).toBe(2_200_000);
    expect(economics.low.driverCostPaisePerMonth).toBeGreaterThan(
      economics.base.driverCostPaisePerMonth,
    );
  });

  it("is a real band, not three copies of the base case", () => {
    expect(economics.low.netProfitPaise).toBeLessThan(
      economics.base.netProfitPaise,
    );
    expect(economics.high.netProfitPaise).toBeGreaterThan(
      economics.base.netProfitPaise,
    );
    expect(economics.low.operatingMarginPaise).toBeLessThan(
      economics.high.operatingMarginPaise,
    );
    expect(economics.low.roiPct).toBeLessThan(economics.high.roiPct);
    expect(economics.low.netProfitPaise).toBe(152_000_000);
    expect(economics.high.netProfitPaise).toBe(428_000_000);
  });

  it("pays back sooner at the top of the band than at the bottom", () => {
    expect(economics.high.paybackMonth).not.toBeNull();
    expect(economics.low.paybackMonth).not.toBeNull();
    expect(economics.high.paybackMonth as number).toBeLessThan(
      economics.low.paybackMonth as number,
    );
  });

  it("takes the range as an input and says it came from the caller", () => {
    const tight = unwrap(
      inputOf({ sensitivity: { revenueSwingPct: 2, driverCostSwingPct: 1 } }),
    );

    expect(tight.sensitivitySource).toBe("supplied");
    expect(tight.low.revenuePaisePerKm).toBe(1_960);
    expect(tight.assumptions.join(" ")).toContain("the range you supplied");
    // A tighter range is a tighter answer.
    expect(tight.high.netProfitPaise - tight.low.netProfitPaise).toBeLessThan(
      economics.high.netProfitPaise - economics.low.netProfitPaise,
    );
  });

  it("falls back to a duty-cycle default, and admits it is not sourced", () => {
    expect(economics.sensitivitySource).toBe("duty_cycle_default");
    expect(economics.sensitivity).toEqual(
      DEFAULT_SENSITIVITY_BY_DUTY_CYCLE.mixed,
    );
    expect(economics.assumptions.join(" ")).toContain("not a sourced figure");
  });

  it("widens the default band for spot freight over contracted last-mile work", () => {
    const width = (dutyCycle: string) => {
      const e = unwrap(inputOf({ profile: profileOf({ dutyCycle }) }));
      return e.high.netProfitPaise - e.low.netProfitPaise;
    };

    expect(width("intercity")).toBeGreaterThan(width("mixed"));
    expect(width("mixed")).toBeGreaterThan(width("urban_distribution"));
    expect(width("urban_distribution")).toBeGreaterThan(width("last_mile"));
  });

  it("collapses to the base case only when the caller says there is no risk", () => {
    const certain = unwrap(
      inputOf({ sensitivity: { revenueSwingPct: 0, driverCostSwingPct: 0 } }),
    );

    expect(certain.low.netProfitPaise).toBe(certain.base.netProfitPaise);
    expect(certain.high.netProfitPaise).toBe(certain.base.netProfitPaise);
  });
});

describe("when the band straddles zero", () => {
  it("says so on both margins when the answer is genuinely 'it depends'", () => {
    // ₹10/km: the low case cannot cover its running costs, the high case can.
    const economics = unwrap(
      inputOf({ profile: profileOf({ revenuePaisePerKm: 1_000 }) }),
    );

    expect(economics.low.operatingMarginPaise).toBeLessThan(0);
    expect(economics.high.operatingMarginPaise).toBeGreaterThan(0);
    expect(economics.operatingMarginStraddlesZero).toBe(true);

    expect(economics.low.netProfitPaise).toBeLessThan(0);
    expect(economics.high.netProfitPaise).toBeGreaterThan(0);
    expect(economics.netProfitStraddlesZero).toBe(true);

    expect(economics.assumptions.join(" ")).toContain("both loss and profit");
  });

  it("shows a base-case loss that the top of the band still turns around", () => {
    const economics = unwrap(
      inputOf({ profile: profileOf({ revenuePaisePerKm: 1_000 }) }),
    );

    // The base case alone would say "do not buy". The band says "it depends".
    expect(economics.base.netProfitPaise).toBeLessThan(0);
    expect(economics.high.netProfitPaise).toBeGreaterThan(0);
  });

  it("separates the two straddles: covering costs is not the same as paying for itself", () => {
    // ₹12/km: every case covers its running costs, but the low case never
    // earns back the vehicle.
    const economics = unwrap(
      inputOf({ profile: profileOf({ revenuePaisePerKm: 1_200 }) }),
    );

    expect(economics.low.operatingMarginPaise).toBeGreaterThan(0);
    expect(economics.operatingMarginStraddlesZero).toBe(false);
    expect(economics.low.netProfitPaise).toBeLessThan(0);
    expect(economics.netProfitStraddlesZero).toBe(true);
  });

  it("stays quiet when the whole band is comfortably profitable", () => {
    const economics = unwrap(inputOf());

    expect(economics.operatingMarginStraddlesZero).toBe(false);
    expect(economics.netProfitStraddlesZero).toBe(false);
    expect(economics.assumptions.join(" ")).not.toContain("both loss and profit");
  });
});

describe("computeCommercialEconomics, refusals", () => {
  it("refuses a cost breakdown costed over a different horizon", () => {
    const result = computeCommercialEconomics(
      inputOf({ tco: breakdown({ ownershipYears: 7, totalKm: 420_000 }) }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("profile_mismatch");
    expect(result.reason).toContain("kilometres nobody drives");
  });

  it("refuses a cost breakdown costed over a different distance", () => {
    const result = computeCommercialEconomics(
      inputOf({ tco: breakdown({ totalKm: 200_000 }) }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("profile_mismatch");
  });

  it("refuses when the profile states no distance", () => {
    const result = computeCommercialEconomics(
      inputOf({
        profile: profileOf({
          usage: {
            dailyKm: 0,
            monthlyKm: 0,
            typicalTripKm: 0.5,
            citySharePct: 50,
          },
        }),
        tco: breakdown({ totalKm: 0 }),
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("distance_missing");
  });

  it("refuses a zero freight rate rather than returning zeroes that read as an answer", () => {
    const result = computeCommercialEconomics(
      inputOf({ profile: profileOf({ revenuePaisePerKm: 0 }) }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("revenue_rate_missing");
    expect(result.reason).toContain("not assumed");
  });

  it("refuses to compute a return when there is no capital at risk", () => {
    const result = computeCommercialEconomics(
      inputOf({ tco: breakdown({ acquisitionPaise: 0 }) }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("capital_missing");
  });

  it("refuses a swing that would put the freight rate below zero", () => {
    const result = computeCommercialEconomics(
      inputOf({ sensitivity: { revenueSwingPct: 150, driverCostSwingPct: 10 } }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("sensitivity_range_invalid");
  });

  it("refuses a negative swing", () => {
    const result = computeCommercialEconomics(
      inputOf({ sensitivity: { revenueSwingPct: 10, driverCostSwingPct: -5 } }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("sensitivity_range_invalid");
  });
});

describe("assumptions", () => {
  const assumptions = unwrap(inputOf()).assumptions.join(" ");

  it("states that the freight rate is held flat, as the cost side is", () => {
    expect(assumptions).toContain("held flat");
  });

  it("states what ROI is measured against", () => {
    expect(assumptions).toContain("not against a down payment");
  });

  it("states that payback excludes the residual and ROI includes it", () => {
    expect(assumptions).toContain("has not yet seen");
  });

  it("states that the low and high cases are adversely paired", () => {
    expect(assumptions).toContain("take turns");
  });
});

describe("composed with computeTco", () => {
  const MH_COMMERCIAL: OnRoadFactors = {
    stateCode: "MH",
    category: "commercial",
    fuelType: null,
    priceBandMinPaise: 0,
    priceBandMaxPaise: null,
    roadTaxPct: 7,
    registrationFeePaise: 100_000,
    insurancePct: 3,
    otherLevyPaise: 0,
    effectiveFrom: "2026-01-01",
  };

  const variant: VariantEconomics = {
    variantId: "lcv-1",
    fuelType: "diesel",
    category: "commercial",
    segment: "lcv",
    exShowroomPaise: lakhs(9),
    realWorldEfficiencyCity: 10,
    realWorldEfficiencyHighway: 13,
    efficiencyUnit: "kmpl",
    batteryKwh: null,
    batteryChemistry: null,
    batteryWarrantyYears: null,
    batteryWarrantyKm: null,
    scheduledServiceCost5yPaise: null,
  };

  const tables: EconomicsTables = {
    energyPrices: {
      diesel: { pricePaise: 9_500, unit: "litre", asOf: "2026-08-01" },
    },
    maintenance: Array.from({ length: 5 }, (_, i) => ({
      segment: "lcv",
      fuelType: "diesel" as const,
      category: "commercial" as const,
      ownershipYear: i + 1,
      costPaise: 2_000_000,
      referenceAnnualKm: 40_000,
      marginalCostPaisePerKm: 150,
    })),
    resale: Array.from({ length: 5 }, (_, i) => ({
      segment: "lcv",
      fuelType: "diesel" as const,
      category: "commercial" as const,
      ageYears: i + 1,
      residualPct: [80, 68, 58, 49, 42][i],
    })),
    batteries: [],
    financeRates: [
      {
        category: "commercial" as const,
        fuelType: null,
        annualRatePct: 11,
        processingFeePct: 1,
      },
    ],
    discountRatePct: 0,
  };

  const profile = profileOf();
  const tcoResult = computeTco({
    profile,
    price: computeOnRoadPrice(lakhs(9), MH_COMMERCIAL),
    variant,
    tables,
  });

  it("accepts a breakdown computeTco produced for the same profile", () => {
    expect(tcoResult.ok).toBe(true);
    if (!tcoResult.ok) return;

    const result = computeCommercialEconomics({ profile, tco: tcoResult.tco });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.economics.variantId).toBe("lcv-1");
    expect(result.economics.totalKm).toBe(300_000);
    expect(result.economics.capitalPaise).toBe(tcoResult.tco.acquisitionPaise);
  });

  it("nets exactly the TCO's own ₹/km and the driver's out of the freight rate", () => {
    if (!tcoResult.ok) throw new Error("TCO failed");
    const economics = unwrap({ profile, tco: tcoResult.tco });

    const driverPaisePerKm =
      (profile.driverCostPaisePerMonth * 60) / tcoResult.tco.totalKm;

    expect(economics.base.netMarginPaisePerKm).toBeCloseTo(
      profile.revenuePaisePerKm -
        tcoResult.tco.costPaisePerKm -
        driverPaisePerKm,
      6,
    );
  });

  it("carries no copy of the TCO's assumptions — the breakdown travels with it", () => {
    if (!tcoResult.ok) throw new Error("TCO failed");
    const economics = unwrap({ profile, tco: tcoResult.tco });

    expect(tcoResult.tco.assumptions.length).toBeGreaterThan(0);
    for (const assumption of tcoResult.tco.assumptions) {
      expect(economics.assumptions).not.toContain(assumption);
    }
  });
});
