import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { computeCo2 } from "./co2";
import { computeCommercialEconomics } from "./commercial";
import {
  AS_OF,
  CANONICAL_PROFILES,
  COMMERCIAL_FLEET,
  emissionFactors,
  ENGINE_VERSION,
  infra,
  onRoadFactors,
  PASSENGER_FLEET,
  tables,
  thinInfra,
} from "./golden.fixtures";
import { computeOnRoadPrice } from "./on-road";
import { runRecommendation, type PipelineInput } from "./pipeline";
import { parseProfile, type RecommendationProfileInput } from "./profile";
import { computeTco } from "./tco";

/**
 * Golden fixtures.
 *
 * Two different jobs, deliberately kept apart:
 *
 *   - the **ranking assertions** pin what the engine recommends to a handful of
 *     canonical people. They are the regression net: a scoring change that
 *     reorders somebody's shortlist has to be looked at, not merged.
 *   - the **calculator snapshots** pin the arithmetic underneath. When a
 *     ranking moves, these say whether the cause was a number or a weight.
 *
 * Every snapshot in this file was read and checked by hand before it was
 * committed. Re-blessing one with `-u` without reading the diff defeats the
 * entire point of the file.
 */

const runFor = (
  key: keyof typeof CANONICAL_PROFILES,
  over: Partial<PipelineInput> = {},
) => {
  const input = CANONICAL_PROFILES[key] as RecommendationProfileInput;
  const profile = parseProfile(input);
  return runRecommendation({
    profile,
    fleet: profile.category === "commercial" ? COMMERCIAL_FLEET : PASSENGER_FLEET,
    onRoadFactors,
    infra,
    tables,
    emissionFactors,
    asOf: AS_OF,
    engineVersion: ENGINE_VERSION,
    ...over,
  });
};

/** The shortlist, as a reviewer would read it: who, in what order, and why. */
const shortlistOf = (result: ReturnType<typeof runFor>) => {
  if (!result.ok) throw new Error(`pipeline failed: ${result.code} ${result.reason}`);
  return result.payload.data.vehicles.map((v) => ({
    name: v.name,
    rank: v.rank,
    score: v.totalScore,
  }));
};

describe("canonical profiles rank the way the product promises", () => {
  it("budget city commuter — 15 km a day, ₹12L cap, no home charging", () => {
    const result = runFor("budgetCityCommuter");
    expect(result.ok).toBe(true);
    expect(shortlistOf(result).slice(0, 3)).toMatchInlineSnapshot(`
      [
        {
          "name": "Alpha Hatch (petrol)",
          "rank": 1,
          "score": 73.09,
        },
        {
          "name": "Delta Hatch (CNG)",
          "rank": 2,
          "score": 58.71,
        },
        {
          "name": "Beta Sedan (petrol)",
          "rank": 3,
          "score": 31.67,
        },
      ]
    `);
  });

  it("high-mileage highway driver — 3,000 km a month", () => {
    const result = runFor("highMileageHighway");
    expect(shortlistOf(result).slice(0, 3)).toMatchInlineSnapshot(`
      [
        {
          "name": "Delta Hatch (CNG)",
          "rank": 1,
          "score": 77.46,
        },
        {
          "name": "Alpha Hatch (petrol)",
          "rank": 2,
          "score": 71.77,
        },
        {
          "name": "Epsilon EV",
          "rank": 3,
          "score": 52.75,
        },
      ]
    `);
  });

  it("eco-first buyer with home charging", () => {
    const result = runFor("ecoFirstWithHomeCharging");
    expect(shortlistOf(result).slice(0, 3)).toMatchInlineSnapshot(`
      [
        {
          "name": "Epsilon EV",
          "rank": 1,
          "score": 79.9,
        },
        {
          "name": "Delta Hatch (CNG)",
          "rank": 2,
          "score": 78.51,
        },
        {
          "name": "Alpha Hatch (petrol)",
          "rank": 3,
          "score": 70.42,
        },
      ]
    `);
  });

  it("large family — seven seats, non-negotiable", () => {
    const result = runFor("largeFamily");
    expect(shortlistOf(result).slice(0, 3)).toMatchInlineSnapshot(`
      [
        {
          "name": "Gamma SUV (diesel)",
          "rank": 1,
          "score": 50,
        },
      ]
    `);
  });

  it("last-mile commercial operator", () => {
    const result = runFor("lastMileOperator");
    expect(shortlistOf(result).slice(0, 3)).toMatchInlineSnapshot(`
      [
        {
          "name": "Kappa Mini Truck (diesel)",
          "rank": 1,
          "score": 85.9,
        },
        {
          "name": "Lambda LCV (diesel)",
          "rank": 2,
          "score": 14.1,
        },
      ]
    `);
  });
});

describe("the shortlist responds to the thing that changed", () => {
  it("offers a family of seven nothing that seats fewer than seven", () => {
    const result = runFor("largeFamily");
    if (!result.ok) throw new Error("expected a ranked result");
    const seatsById = new Map(
      PASSENGER_FLEET.map((v) => [v.variant.name, v.variant.seatingCapacity]),
    );
    for (const vehicle of result.payload.data.vehicles) {
      expect(seatsById.get(vehicle.name)).toBeGreaterThanOrEqual(7);
    }
    // And the five-seaters were reported as excluded, not quietly dropped.
    const seating = result.payload.data.exclusions.filter(
      (e) => e.code === "seating_below_requirement",
    );
    expect(seating.length).toBeGreaterThan(0);
    expect(seating[0].reason).toContain("below the 7 you need");
  });

  it("gates CNG and EV out of a town with neither network", () => {
    const served = shortlistOf(runFor("highMileageHighway")).map((v) => v.name);
    const thin = shortlistOf(runFor("highMileageHighway", { infra: thinInfra })).map(
      (v) => v.name,
    );
    expect(served).toContain("Delta Hatch (CNG)");
    expect(served).toContain("Epsilon EV");
    expect(thin).not.toContain("Delta Hatch (CNG)");
    expect(thin).not.toContain("Epsilon EV");
  });

  it("reports every gated vehicle with a reason rather than dropping it silently", () => {
    const result = runFor("highMileageHighway", { infra: thinInfra });
    if (!result.ok) throw new Error("expected a ranked result");
    const gated = result.payload.data.exclusions.filter(
      (e) => e.stage === "feasibility_gate",
    );
    expect(gated.length).toBeGreaterThan(0);
    for (const exclusion of gated) {
      expect(exclusion.reason).not.toBe("");
    }
    expect(gated.map((e) => `${e.name}: ${e.reason}`)).toMatchInlineSnapshot(`
      [
        "Delta Hatch (CNG): No CNG stations recorded in your area.",
        "Epsilon EV: You have no home charging, and public fast charging here is either sparse or too thinly evidenced to rely on.",
      ]
    `);
  });
});

describe("weights follow the persona (FR-A8)", () => {
  it("weights cost above environment for the budget commuter", () => {
    const result = runFor("budgetCityCommuter");
    if (!result.ok) throw new Error("expected a ranked result");
    const { weights } = result.payload.data;
    // `weights` is a Partial — a dimension the category does not score is
    // absent rather than zero, so assert presence before comparing.
    expect(weights.cost).toBeDefined();
    expect(weights.environment).toBeDefined();
    expect(weights.cost!).toBeGreaterThan(weights.environment!);
  });

  it("weights environment up when the buyer says it matters", () => {
    const eco = runFor("ecoFirstWithHomeCharging");
    const commuter = runFor("budgetCityCommuter");
    if (!eco.ok || !commuter.ok) throw new Error("expected ranked results");
    const ecoWeight = eco.payload.data.weights.environment;
    const commuterWeight = commuter.payload.data.weights.environment;
    expect(ecoWeight).toBeDefined();
    expect(commuterWeight).toBeDefined();
    expect(ecoWeight!).toBeGreaterThan(commuterWeight!);
  });

  it("redistributes a missing dimension's weight rather than scoring it zero", () => {
    // `limit: 6` so the whole fleet is ranked — the hybrid is the priciest
    // vehicle and falls off the end of the default five.
    const result = runFor("ecoFirstWithHomeCharging", { limit: 6 });
    if (!result.ok) throw new Error("expected a ranked result");
    const hybrid = result.payload.data.vehicles.find((v) => v.name === "Zeta Hybrid");
    expect(hybrid).toBeDefined();

    // The hybrid has no service centre count and no liquidity score by
    // construction. Both must read as unknown, and neither may read as zero.
    const reliability = hybrid!.subScores.find((s) => s.dimension === "reliability");
    expect(reliability?.score).toBeNull();
    const resale = hybrid!.subScores.find((s) => s.dimension === "resale");
    expect(resale?.score).toBeNull();

    // The vehicle still ranks — an unscored dimension is not a disqualification.
    expect(hybrid!.totalScore).toBeGreaterThan(0);

    // And the weight went somewhere: a scored dimension carries more than the
    // persona weight it started with.
    const cost = hybrid!.subScores.find((s) => s.dimension === "cost");
    expect(cost?.weight).toBeGreaterThan(result.payload.data.weights.cost!);
  });

  /**
   * Not `toBeCloseTo(1, 6)`. Weights are deliberately rounded to four places
   * before they are published and before they are applied, so a set of seven
   * of them sums to 1 give or take a few parts in ten thousand. Demanding
   * exactness here would force a fudge factor into the engine to satisfy a
   * test, which is the wrong way round.
   */
  it("keeps every weight set summing to 1, to within its own rounding", () => {
    for (const key of Object.keys(CANONICAL_PROFILES)) {
      const result = runFor(key);
      if (!result.ok) continue;
      const total = Object.values(result.payload.data.weights).reduce(
        (sum, w) => sum + w,
        0,
      );
      expect(total).toBeCloseTo(1, 3);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Calculator snapshots                                                        */
/* -------------------------------------------------------------------------- */

const goldenVariant = (variantId: string) => {
  const entry = [...PASSENGER_FLEET, ...COMMERCIAL_FLEET].find(
    (v) => v.variant.variantId === variantId,
  );
  if (entry === undefined) throw new Error(`no fixture vehicle ${variantId}`);
  return entry;
};

const economicsOf = (variantId: string) => {
  const entry = goldenVariant(variantId);
  return {
    variantId,
    fuelType: entry.variant.fuelType,
    category: entry.variant.category,
    exShowroomPaise: entry.variant.exShowroomPaise!,
    ...entry.economics,
  };
};

const priceOf = (variantId: string) => {
  const entry = goldenVariant(variantId);
  const factors = onRoadFactors.find((f) => f.category === entry.variant.category)!;
  return computeOnRoadPrice(entry.variant.exShowroomPaise!, factors);
};

describe("on-road price", () => {
  it("₹6L ex-showroom in KA, 10% road tax, 3% insurance, ₹1,000 registration", () => {
    expect(priceOf("p-petrol-hatch")).toMatchInlineSnapshot(`
      {
        "exShowroomPaise": 60000000,
        "factors": {
          "category": "passenger",
          "effectiveFrom": "2026-01-01",
          "fuelType": null,
          "insurancePct": 3,
          "otherLevyPaise": 0,
          "priceBandMaxPaise": null,
          "priceBandMinPaise": 0,
          "registrationFeePaise": 100000,
          "roadTaxPct": 10,
          "stateCode": "KA",
        },
        "insurancePaise": 1800000,
        "onRoadPaise": 67900000,
        "otherLevyPaise": 0,
        "registrationFeePaise": 100000,
        "roadTaxPaise": 6000000,
      }
    `);
  });
});

describe("TCO snapshots", () => {
  /**
   * One snapshot covering every case rather than one per case: an `it.each`
   * shares a single call site, so inline snapshots written from inside one
   * overwrite each other on every run.
   */
  it("costs each powertrain against the profile that would buy it", () => {
    const cases = [
      ["p-petrol-hatch", "budgetCityCommuter"],
      ["p-cng-hatch", "budgetCityCommuter"],
      ["p-petrol-sedan", "highMileageHighway"],
      ["p-electric", "ecoFirstWithHomeCharging"],
      ["p-hybrid", "highMileageHighway"],
    ] as const;

    const costed = Object.fromEntries(
      cases.map(([variantId, profileKey]) => {
        const profile = parseProfile(
          CANONICAL_PROFILES[profileKey] as RecommendationProfileInput,
        );
        const result = computeTco({
          profile,
          price: priceOf(variantId),
          variant: economicsOf(variantId),
          tables,
        });
        if (!result.ok) {
          throw new Error(`${variantId}: ${result.code} ${result.reason}`);
        }
        return [
          `${variantId} / ${profileKey}`,
          {
            totalPaise: result.tco.totalPaise,
            costPaisePerKm: result.tco.costPaisePerKm,
            resaleCreditPaise: result.tco.resaleCreditPaise,
            energyPaise: result.tco.energyPaise,
            maintenancePaise: result.tco.maintenancePaise,
          },
        ];
      }),
    );

    expect(costed).toMatchInlineSnapshot(`
      {
        "p-cng-hatch / budgetCityCommuter": {
          "costPaisePerKm": 3431.6674166666667,
          "energyPaise": 7942855,
          "maintenancePaise": 2750000,
          "resaleCreditPaise": 25072837,
          "totalPaise": 82360018,
        },
        "p-electric / ecoFirstWithHomeCharging": {
          "costPaisePerKm": 1152.4022777777777,
          "energyPaise": 19968000,
          "maintenancePaise": 5800000,
          "resaleCreditPaise": 8122072,
          "totalPaise": 165945928,
        },
        "p-hybrid / highMileageHighway": {
          "costPaisePerKm": 1381.0083293650794,
          "energyPaise": 111796363,
          "maintenancePaise": 21000000,
          "resaleCreditPaise": 22741803,
          "totalPaise": 348014099,
        },
        "p-petrol-hatch / budgetCityCommuter": {
          "costPaisePerKm": 3013.5571666666665,
          "energyPaise": 15800000,
          "maintenancePaise": 2750000,
          "resaleCreditPaise": 18804628,
          "totalPaise": 72325372,
        },
        "p-petrol-sedan / highMileageHighway": {
          "costPaisePerKm": 1228.4013055555556,
          "energyPaise": 154000000,
          "maintenancePaise": 21000000,
          "resaleCreditPaise": 14213627,
          "totalPaise": 309557129,
        },
      }
    `);
  });

  it("the total is the sum of its parts, minus the resale credit", () => {
    const profile = parseProfile(
      CANONICAL_PROFILES.budgetCityCommuter as RecommendationProfileInput,
    );
    const result = computeTco({
      profile,
      price: priceOf("p-petrol-hatch"),
      variant: economicsOf("p-petrol-hatch"),
      tables,
    });
    if (!result.ok) throw new Error("expected a costed vehicle");
    const yearly = result.tco.yearly.reduce((sum, y) => sum + y.totalPaise, 0);
    expect(result.tco.totalPaise).toBe(
      result.tco.acquisitionPaise + yearly - result.tco.resaleCreditPaise,
    );
  });

  it("costs a longer horizon more than a shorter one, all else equal", () => {
    const base = CANONICAL_PROFILES.budgetCityCommuter as RecommendationProfileInput;
    const cost = (ownershipYears: number) => {
      const result = computeTco({
        profile: parseProfile({ ...base, ownershipYears }),
        price: priceOf("p-petrol-hatch"),
        variant: economicsOf("p-petrol-hatch"),
        tables,
      });
      if (!result.ok) throw new Error("expected a costed vehicle");
      return result.tco.totalPaise;
    };
    expect(cost(8)).toBeGreaterThan(cost(3));
  });
});

describe("CO2 snapshots", () => {
  it("computes well-to-wheel carbon for every powertrain", () => {
    const profile = parseProfile(
      CANONICAL_PROFILES.ecoFirstWithHomeCharging as RecommendationProfileInput,
    );
    const emitted = Object.fromEntries(
      (
        [
          "p-petrol-hatch",
          "p-diesel-suv",
          "p-cng-hatch",
          "p-electric",
          "p-hybrid",
        ] as const
      ).map((variantId) => {
        const result = computeCo2({
          profile,
          variant: economicsOf(variantId),
          factors: emissionFactors,
          asOf: AS_OF,
        });
        if (!result.ok) {
          throw new Error(`${variantId}: ${result.code} ${result.reason}`);
        }
        return [
          variantId,
          {
            gramsCo2ePerKm: result.co2.gramsCo2ePerKm,
            effectiveEfficiency: result.co2.effectiveEfficiency,
            annualGramsCo2e: result.co2.annualGramsCo2e,
            horizonGramsCo2e: result.co2.horizonGramsCo2e,
          },
        ];
      }),
    );
    expect(emitted).toMatchInlineSnapshot(`
      {
        "p-cng-hatch": {
          "annualGramsCo2e": 1821429,
          "effectiveEfficiency": 24.70588235294118,
          "gramsCo2ePerKm": 101.19047619047618,
          "horizonGramsCo2e": 14571429,
        },
        "p-diesel-suv": {
          "annualGramsCo2e": 3625714,
          "effectiveEfficiency": 14.893617021276595,
          "gramsCo2ePerKm": 201.42857142857144,
          "horizonGramsCo2e": 29005714,
        },
        "p-electric": {
          "annualGramsCo2e": 2184000,
          "effectiveEfficiency": 5.769230769230769,
          "gramsCo2ePerKm": 121.33333333333333,
          "horizonGramsCo2e": 17472000,
        },
        "p-hybrid": {
          "annualGramsCo2e": 2070982,
          "effectiveEfficiency": 24.33628318584071,
          "gramsCo2ePerKm": 115.05454545454545,
          "horizonGramsCo2e": 16567855,
        },
        "p-petrol-hatch": {
          "annualGramsCo2e": 3192000,
          "effectiveEfficiency": 15.789473684210526,
          "gramsCo2ePerKm": 177.33333333333334,
          "horizonGramsCo2e": 25536000,
        },
      }
    `);
  });

  const perKmFor = (variantId: string) => {
    const profile = parseProfile(
      CANONICAL_PROFILES.ecoFirstWithHomeCharging as RecommendationProfileInput,
    );
    const result = computeCo2({
      profile,
      variant: economicsOf(variantId),
      factors: emissionFactors,
      asOf: AS_OF,
    });
    if (!result.ok) throw new Error(variantId);
    return result.co2.gramsCo2ePerKm;
  };

  it("ranks the combustion powertrains by carbon the way the factors imply", () => {
    expect(perKmFor("p-hybrid")).toBeLessThan(perKmFor("p-petrol-hatch"));
    expect(perKmFor("p-petrol-hatch")).toBeLessThan(perKmFor("p-diesel-suv"));
    expect(perKmFor("p-cng-hatch")).toBeLessThan(perKmFor("p-petrol-hatch"));
  });

  /**
   * Worth stating plainly, because it is counter-intuitive and it is the whole
   * reason the calculation is well-to-wheel rather than tailpipe.
   *
   * At the fixture's 700 g/kWh grid — squarely in the range of a coal-heavy
   * Indian grid — a 24 kmpl strong hybrid emits slightly *less* per kilometre
   * than a 5.8 km/kWh EV. A tailpipe-only calculation would have shown the EV
   * at zero and been confidently wrong. The engine must be able to return this
   * answer; if a change ever makes the EV unconditionally cleanest, it has
   * stopped reading the grid factor.
   */
  it("lets a dirty grid make a strong hybrid cleaner than an EV", () => {
    expect(perKmFor("p-electric")).toBeGreaterThan(perKmFor("p-hybrid"));
    // ...and the same EV is cleaner than the petrol car it would replace.
    expect(perKmFor("p-electric")).toBeLessThan(perKmFor("p-petrol-hatch"));
  });
});

describe("commercial economics snapshots", () => {
  it("returns margin, ROI and payback as a band for each vehicle", () => {
    const profile = parseProfile(
      CANONICAL_PROFILES.lastMileOperator as RecommendationProfileInput,
    );
    if (profile.category !== "commercial") throw new Error("expected commercial");

    const economics = Object.fromEntries(
      (["c-mini-truck", "c-lcv"] as const).map((variantId) => {
        const tco = computeTco({
          profile,
          price: priceOf(variantId),
          variant: economicsOf(variantId),
          tables,
        });
        if (!tco.ok) throw new Error(`${variantId}: ${tco.code}`);
        const result = computeCommercialEconomics({ profile, tco: tco.tco });
        if (!result.ok) {
          throw new Error(`${variantId}: ${result.code} ${result.reason}`);
        }
        const { base, low, high, netProfitStraddlesZero } = result.economics;
        return [
          variantId,
          {
            netProfitStraddlesZero,
            scenarios: [low, base, high].map((s) => ({
              label: s.label,
              netMarginPaisePerKm: s.netMarginPaisePerKm,
              roiPct: s.roiPct,
              paybackMonth: s.paybackMonth,
            })),
          },
        ];
      }),
    );

    expect(economics).toMatchInlineSnapshot(`
      {
        "c-lcv": {
          "netProfitStraddlesZero": false,
          "scenarios": [
            {
              "label": "low",
              "netMarginPaisePerKm": 326.07677884615384,
              "paybackMonth": 60,
              "roiPct": 45.046222476408346,
            },
            {
              "label": "base",
              "netMarginPaisePerKm": 576.0767788461538,
              "paybackMonth": 49,
              "roiPct": 79.58273764609297,
            },
            {
              "label": "high",
              "netMarginPaisePerKm": 826.0767788461538,
              "paybackMonth": 40,
              "roiPct": 114.11925281577757,
            },
          ],
        },
        "c-mini-truck": {
          "netProfitStraddlesZero": false,
          "scenarios": [
            {
              "label": "low",
              "netMarginPaisePerKm": 1015.2102243589744,
              "paybackMonth": 24,
              "roiPct": 240.2963177443062,
            },
            {
              "label": "base",
              "netMarginPaisePerKm": 1265.2102243589743,
              "paybackMonth": 20,
              "roiPct": 299.47034692039006,
            },
            {
              "label": "high",
              "netMarginPaisePerKm": 1515.2102243589743,
              "paybackMonth": 18,
              "roiPct": 358.6443760964739,
            },
          ],
        },
      }
    `);
  });

  it("returns a band, not a point — low never beats high", () => {
    const profile = parseProfile(
      CANONICAL_PROFILES.lastMileOperator as RecommendationProfileInput,
    );
    if (profile.category !== "commercial") throw new Error("expected commercial");
    const tco = computeTco({
      profile,
      price: priceOf("c-mini-truck"),
      variant: economicsOf("c-mini-truck"),
      tables,
    });
    if (!tco.ok) throw new Error("expected a costed vehicle");
    const result = computeCommercialEconomics({ profile, tco: tco.tco });
    if (!result.ok) throw new Error("expected commercial economics");
    const { low, base, high } = result.economics;
    expect(low.netProfitPaise).toBeLessThan(base.netProfitPaise);
    expect(base.netProfitPaise).toBeLessThan(high.netProfitPaise);
    expect(result.economics.sensitivitySource).toBe("duty_cycle_default");
  });
});

/* -------------------------------------------------------------------------- */
/* FR-A7 — claimed figures may never reach a calculation                       */
/* -------------------------------------------------------------------------- */

/**
 * Stage 1 avoids this structurally: `CandidateVariant` has no
 * `claimedEfficiency` or `claimedRangeKm` field, so a calculation cannot read
 * one without a type error. That protection ends the moment somebody adds the
 * field "just for display" — the type stops objecting and every calculator
 * downstream can suddenly reach an ARAI number.
 *
 * So this is a source-text assertion rather than a behavioural one. It is the
 * only test in the suite that reads the engine as text, and it is deliberate:
 * the property being defended is "this name appears nowhere in a calculation
 * path", which no amount of running the code can demonstrate.
 */
describe("FR-A7 — no engine calculation touches a claimed figure", () => {
  const ENGINE_DIR = join(__dirname);
  const FORBIDDEN = /\bclaimed(Efficiency|RangeKm|Range)\b/;

  const engineSources = readdirSync(ENGINE_DIR)
    .filter((f) => f.endsWith(".ts"))
    .filter((f) => !f.endsWith(".test.ts"))
    .filter((f) => !f.endsWith(".fixtures.ts"));

  it("finds the engine modules it is supposed to be guarding", () => {
    // A guard that silently reads zero files passes forever.
    expect(engineSources.length).toBeGreaterThan(8);
    expect(engineSources).toContain("tco.ts");
    expect(engineSources).toContain("stage1.ts");
    expect(engineSources).toContain("co2.ts");
  });

  it.each([...engineSources])("%s never names a claimed figure", (file) => {
    const source = readFileSync(join(ENGINE_DIR, file), "utf8");
    const offending = source
      .split("\n")
      .map((line, i) => ({ line, number: i + 1 }))
      // The doc comments that explain *why* the fields are absent are allowed
      // to name them; a comment cannot be multiplied by a fuel price.
      .filter(({ line }) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .filter(({ line }) => FORBIDDEN.test(line));

    expect(
      offending.map((o) => `${file}:${o.number}: ${o.line.trim()}`),
    ).toEqual([]);
  });

  it("would catch the thing it is guarding against", () => {
    // Proves the regex matches the real field names, so a passing suite above
    // means "absent", not "misspelled in the guard".
    expect(FORBIDDEN.test("const x = variant.claimedEfficiency * price;")).toBe(true);
    expect(FORBIDDEN.test("const x = variant.claimedRangeKm / 2;")).toBe(true);
    expect(FORBIDDEN.test("const x = variant.realWorldEfficiencyCity;")).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Reproducibility (FR-A12)                                                    */
/* -------------------------------------------------------------------------- */

describe("a run is reproducible", () => {
  it("returns an identical payload for identical input", () => {
    expect(runFor("highMileageHighway")).toEqual(runFor("highMileageHighway"));
  });

  it("does not depend on the order the fleet arrives in", () => {
    const forward = runFor("highMileageHighway");
    const reversed = runFor("highMileageHighway", {
      fleet: [...PASSENGER_FLEET].reverse(),
    });
    expect(shortlistOf(reversed)).toEqual(shortlistOf(forward));
  });

  it("stamps the run with the engine version and asOf it was given", () => {
    const result = runFor("budgetCityCommuter");
    if (!result.ok) throw new Error("expected a ranked result");
    expect(result.payload.data.run.asOf).toBe(AS_OF);
    expect(result.payload.data.run.engineVersion).toBe(ENGINE_VERSION);
  });
});
