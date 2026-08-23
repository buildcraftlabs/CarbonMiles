import { describe, expect, it } from "vitest";

import {
  blendPerUnitFactors,
  canonicalFactorUnit,
  computeCo2,
  CO2_CONVENTIONS,
  fuelUnitOf,
  selectEmissionFactor,
  type Co2Breakdown,
  type Co2Input,
  type EmissionFactor,
  type EthanolBlend,
  type VariantEmissions,
} from "./co2";
import { parseProfile, type RecommendationProfileInput } from "./profile";

const lakhs = (n: number) => Math.round(n * 10_000_000);

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

/**
 * The blends the calculators actually use, written as the arithmetic rather
 * than as a decimal so the relationship stays visible: over 100 km, 70 of them
 * at the city figure and 30 at the highway one. These are harmonic means —
 * what blends linearly is fuel per km, not km per litre.
 */
const PETROL_BLEND = 100 / (70 / 20 + 30 / 25); // 21.2766 kmpl
const EV_BLEND = 100 / (70 / 6 + 30 / 5); // 5.6604 km/kWh

/** 20 kmpl city / 25 highway at the profile's 70% city split — see `PETROL_BLEND`. */
const petrolVariant = (over: Partial<VariantEmissions> = {}): VariantEmissions => ({
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

/**
 * The seed values from the issue, as `emission_factors` rows: petrol 2.31 kg/l,
 * diesel 2.68 kg/l, CNG 2.16 kg/kg, grid ~0.71 kg/kWh. They live in fixtures
 * and in the database — never in `co2.ts`.
 */
const factor = (over: Partial<EmissionFactor> = {}): EmissionFactor => ({
  fuelType: "petrol",
  gramsCo2ePerUnit: 2310,
  unit: "litre",
  scope: "well_to_wheel",
  stateCode: null,
  asOf: "2026-04-01",
  ...over,
});

const FACTORS: readonly EmissionFactor[] = [
  factor(),
  factor({ fuelType: "diesel", gramsCo2ePerUnit: 2680 }),
  factor({ fuelType: "cng", gramsCo2ePerUnit: 2160, unit: "kg" }),
  factor({ fuelType: "electric", gramsCo2ePerUnit: 710, unit: "kwh" }),
];

/** E20 against an E10 baseline, with a 3% real-world efficiency loss. */
const e20 = (over: Partial<EthanolBlend> = {}): EthanolBlend => ({
  ethanolSharePct: 20,
  baselineEthanolSharePct: 10,
  efficiencyPenaltyPct: 3,
  fossilGramsCo2ePerLitre: 600,
  biogenicGramsCo2PerLitre: 1510,
  asOf: "2026-04-01",
  ...over,
});

const inputOf = (over: Partial<Co2Input> = {}): Co2Input => ({
  profile: profileOf(),
  variant: petrolVariant(),
  factors: FACTORS,
  asOf: "2026-08-01",
  ...over,
});

const unwrap = (input: Co2Input): Co2Breakdown => {
  const result = computeCo2(input);
  if (!result.ok) throw new Error(`${result.code}: ${result.reason}`);
  return result.co2;
};

describe("fuelUnitOf / canonicalFactorUnit", () => {
  it("maps an efficiency unit to the unit its factor must be denominated in", () => {
    expect(fuelUnitOf("kmpl")).toBe("litre");
    expect(fuelUnitOf("km/kg")).toBe("kg");
    expect(fuelUnitOf("km/kWh")).toBe("kwh");
  });

  it("refuses to guess at an unrecognised unit", () => {
    expect(fuelUnitOf("mpg")).toBeNull();
    expect(fuelUnitOf(null)).toBeNull();
    expect(canonicalFactorUnit("gallons")).toBeNull();
  });

  it("accepts the spellings the catalogue actually uses", () => {
    expect(canonicalFactorUnit("litre")).toBe("litre");
    expect(canonicalFactorUnit("L")).toBe("litre");
    expect(canonicalFactorUnit("kWh")).toBe("kwh");
  });
});

describe("selectEmissionFactor", () => {
  const national = factor({ fuelType: "electric", gramsCo2ePerUnit: 710, unit: "kwh" });
  const mh = factor({
    fuelType: "electric",
    gramsCo2ePerUnit: 620,
    unit: "kwh",
    stateCode: "MH",
  });

  it("prefers the state row over the national one", () => {
    expect(
      selectEmissionFactor([national, mh], {
        fuelType: "electric",
        stateCode: "MH",
        asOf: "2026-08-01",
      }),
    ).toBe(mh);
  });

  it("falls back to the national row for a state with no row of its own", () => {
    expect(
      selectEmissionFactor([national, mh], {
        fuelType: "electric",
        stateCode: "KA",
        asOf: "2026-08-01",
      }),
    ).toBe(national);
  });

  it("takes the most recently effective row of equal specificity", () => {
    const older = factor({ gramsCo2ePerUnit: 2250, asOf: "2025-04-01" });
    const newer = factor({ gramsCo2ePerUnit: 2310, asOf: "2026-04-01" });

    expect(
      selectEmissionFactor([older, newer], {
        fuelType: "petrol",
        stateCode: "MH",
        asOf: "2026-08-01",
      }),
    ).toBe(newer);
  });

  it("ignores a row that is not yet effective, so a run replays to itself", () => {
    const future = factor({ gramsCo2ePerUnit: 9999, asOf: "2027-01-01" });

    expect(
      selectEmissionFactor([factor(), future], {
        fuelType: "petrol",
        stateCode: "MH",
        asOf: "2026-08-01",
      })?.gramsCo2ePerUnit,
    ).toBe(2310);
  });

  it("does not substitute one scope for another", () => {
    const tankToWheel = factor({ gramsCo2ePerUnit: 2310, scope: "tank_to_wheel" });

    expect(
      selectEmissionFactor([tankToWheel], {
        fuelType: "petrol",
        stateCode: "MH",
        asOf: "2026-08-01",
      }),
    ).toBeNull();
    expect(
      selectEmissionFactor([tankToWheel], {
        fuelType: "petrol",
        stateCode: "MH",
        asOf: "2026-08-01",
        scope: "tank_to_wheel",
      }),
    ).toBe(tankToWheel);
  });

  it("returns null rather than any row when the fuel has none", () => {
    expect(
      selectEmissionFactor(FACTORS, {
        fuelType: "hydrogen",
        stateCode: "MH",
        asOf: "2026-08-01",
      }),
    ).toBeNull();
  });
});

describe("computeCo2, petrol baseline", () => {
  const co2 = unwrap(inputOf());

  it("divides the per-litre factor by the blended real-world efficiency", () => {
    // 2,310 g/l at PETROL_BLEND kmpl.
    expect(co2.gramsCo2ePerKm).toBeCloseTo(2310 / PETROL_BLEND, 9);
    expect(co2.effectiveEfficiency).toBeCloseTo(PETROL_BLEND, 9);
  });

  it("multiplies out over the horizon, in whole grams CO2e", () => {
    expect(co2.totalKm).toBe(72_000);
    expect(co2.annualGramsCo2e).toBe(1_563_408);
    expect(co2.horizonGramsCo2e).toBe(7_817_040);
    expect(Number.isInteger(co2.horizonGramsCo2e)).toBe(true);
  });

  it("scales the horizon total with the ownership duration, nothing else", () => {
    const tenYears = unwrap(inputOf({ profile: profileOf({ ownershipYears: 10 }) }));

    expect(tenYears.gramsCo2ePerKm).toBeCloseTo(co2.gramsCo2ePerKm, 9);
    expect(tenYears.horizonGramsCo2e).toBe(co2.horizonGramsCo2e * 2);
  });

  it("carries the row that produced the figure, with its date and scope", () => {
    expect(co2.factor.asOf).toBe("2026-04-01");
    expect(co2.scope).toBe("well_to_wheel");
    expect(co2.assumptions.join(" ")).toContain("2026-04-01");
    expect(co2.assumptions.join(" ")).toContain("2310 g CO2e per litre");
  });

  it("says the figure is fuel-cycle only, not cradle-to-grave", () => {
    expect(CO2_CONVENTIONS.includesEmbodiedEmissions).toBe(false);
    expect(co2.assumptions.join(" ")).toContain("Manufacturing the vehicle");
  });

  it("reports no biogenic carbon for a vehicle with no blend on file", () => {
    expect(co2.biogenicGramsCo2PerKm).toBe(0);
    expect(co2.horizonBiogenicGramsCo2).toBe(0);
    expect(co2.blend).toBeNull();
  });

  it("costs CNG per kilogram, not per litre", () => {
    const cng = unwrap(
      inputOf({
        variant: petrolVariant({ fuelType: "cng", efficiencyUnit: "km/kg" }),
      }),
    );

    expect(cng.gramsCo2ePerKm).toBeCloseTo(2160 / PETROL_BLEND, 9);
    expect(cng.factor.unit).toBe("kg");
  });
});

describe("computeCo2, FR-A7", () => {
  it("cannot reach a claimed figure, because the input type has none", () => {
    const withClaims = {
      ...petrolVariant(),
      // ARAI figures, deliberately flattering and deliberately not on the type.
      claimedEfficiency: 28,
      claimedRangeKm: 700,
    } as VariantEmissions;

    expect(unwrap(inputOf({ variant: withClaims })).gramsCo2ePerKm).toBeCloseTo(
      unwrap(inputOf()).gramsCo2ePerKm,
      9,
    );
  });

  it("uses the same city/highway blend TCO does, including its fallback", () => {
    const cityOnly = unwrap(
      inputOf({
        variant: petrolVariant({ realWorldEfficiencyHighway: null }),
      }),
    );

    expect(cityOnly.effectiveEfficiency).toBe(20);
    expect(cityOnly.assumptions.join(" ")).toContain("city figure");
  });
});

describe("computeCo2, the state grid factor", () => {
  const gridFactors: readonly EmissionFactor[] = [
    ...FACTORS,
    factor({
      fuelType: "electric",
      gramsCo2ePerUnit: 620,
      unit: "kwh",
      stateCode: "MH",
    }),
  ];

  /** 6 km/kWh city, 5 highway — see `EV_BLEND` for the 70% city split. */
  const ev = (over: Partial<VariantEmissions> = {}) =>
    petrolVariant({
      fuelType: "electric",
      realWorldEfficiencyCity: 6,
      realWorldEfficiencyHighway: 5,
      efficiencyUnit: "km/kWh",
      batteryKwh: 40,
      batteryChemistry: "lfp",
      ...over,
    });

  it("prefers the state grid factor over the national average", () => {
    const co2 = unwrap(inputOf({ variant: ev(), factors: gridFactors }));

    expect(co2.factor.stateCode).toBe("MH");
    expect(co2.appliedGramsCo2ePerUnit).toBe(620);
    expect(co2.gramsCo2ePerKm).toBeCloseTo(620 / EV_BLEND, 9);
  });

  it("falls back to the national grid factor, and says the state is missing", () => {
    const co2 = unwrap(
      inputOf({
        profile: profileOf({ location: { stateCode: "KA" } }),
        variant: ev(),
        factors: gridFactors,
      }),
    );

    expect(co2.factor.stateCode).toBeNull();
    expect(co2.gramsCo2ePerKm).toBeCloseTo(710 / EV_BLEND, 9);
    expect(co2.assumptions.join(" ")).toContain("No KA grid emission factor");
    expect(co2.assumptions.join(" ")).toContain("coal-heavy");
  });

  it("does not claim a state figure it never used", () => {
    const co2 = unwrap(inputOf({ variant: ev(), factors: gridFactors }));

    expect(co2.assumptions.join(" ")).not.toContain("No MH grid emission factor");
  });

  it("states that the grid factor is held flat, and that losses are not modelled", () => {
    const co2 = unwrap(inputOf({ variant: ev(), factors: gridFactors }));

    expect(co2.assumptions.join(" ")).toContain("held at its");
    expect(co2.assumptions.join(" ")).toContain("Charging and grid transmission losses");
    expect(CO2_CONVENTIONS.chargingLossPct).toBe(0);
    expect(CO2_CONVENTIONS.factorDriftPctPerYear).toBe(0);
  });

  it("does not talk about the grid for a vehicle that does not use one", () => {
    const co2 = unwrap(inputOf());
    expect(co2.assumptions.join(" ")).not.toContain("grid");
  });
});

describe("blendPerUnitFactors", () => {
  it("counts the whole litre as fossil when there is no blend", () => {
    expect(blendPerUnitFactors(2310, null)).toEqual({ counted: 2310, biogenic: 0 });
  });

  it("splits a blend by volume share", () => {
    // 80% of 2,310 fossil petrol + 20% of 600 well-to-tank ethanol.
    expect(blendPerUnitFactors(2310, e20())).toEqual({
      counted: 1968,
      biogenic: 302,
    });
  });

  it("is the neat-petrol figure at a zero ethanol share", () => {
    expect(blendPerUnitFactors(2310, e20({ ethanolSharePct: 0 }))).toEqual({
      counted: 2310,
      biogenic: 0,
    });
  });
});

describe("computeCo2, the E20 adjustment", () => {
  const blended = unwrap(inputOf({ blend: e20() }));

  it("applies the blend's efficiency penalty to the real-world figure", () => {
    // PETROL_BLEND kmpl, less the 3% the compatibility record publishes.
    expect(blended.effectiveEfficiency).toBeCloseTo(PETROL_BLEND * 0.97, 9);
    expect(blended.gramsCo2ePerKm).toBeCloseTo(1968 / (PETROL_BLEND * 0.97), 9);
  });

  it("takes the penalty from the caller and never invents one", () => {
    const gentler = unwrap(inputOf({ blend: e20({ efficiencyPenaltyPct: 2 }) }));
    const harsher = unwrap(inputOf({ blend: e20({ efficiencyPenaltyPct: 6 }) }));

    expect(gentler.effectiveEfficiency).toBeCloseTo(PETROL_BLEND * 0.98, 9);
    expect(harsher.effectiveEfficiency).toBeCloseTo(PETROL_BLEND * 0.94, 9);
    expect(harsher.gramsCo2ePerKm).toBeGreaterThan(gentler.gramsCo2ePerKm);
  });

  it("is a separate effect from the carbon split: without the penalty the answer differs", () => {
    const noPenalty = unwrap(inputOf({ blend: e20({ efficiencyPenaltyPct: 0 }) }));

    expect(noPenalty.appliedGramsCo2ePerUnit).toBe(blended.appliedGramsCo2ePerUnit);
    expect(noPenalty.gramsCo2ePerKm).toBeCloseTo(1968 / PETROL_BLEND, 9);
    expect(noPenalty.gramsCo2ePerKm).toBeLessThan(blended.gramsCo2ePerKm);
  });

  it("reports biogenic carbon beside the total, never inside it", () => {
    expect(blended.biogenicGramsCo2PerKm).toBeCloseTo(302 / (PETROL_BLEND * 0.97), 9);
    // The counted figure is the fossil one alone.
    expect(blended.gramsCo2ePerKm).toBeCloseTo(1968 / (PETROL_BLEND * 0.97), 9);
    expect(blended.gramsCo2ePerKm).toBeLessThan(
      (1968 + 302) / (PETROL_BLEND * 0.97),
    );
    expect(blended.horizonGramsCo2e).toBe(6_865_682);
    expect(blended.horizonBiogenicGramsCo2).toBe(1_053_575);
    expect(CO2_CONVENTIONS.countBiogenicCarbon).toBe(false);
  });

  it("still counts the ethanol's cultivation and distillation as fossil", () => {
    const freeEthanol = unwrap(
      inputOf({ blend: e20({ fossilGramsCo2ePerLitre: 0 }) }),
    );

    expect(freeEthanol.gramsCo2ePerKm).toBeLessThan(blended.gramsCo2ePerKm);
    expect(blended.appliedGramsCo2ePerUnit).toBe(1968);
  });

  it("nets out lower than neat petrol, but by less than the ethanol share", () => {
    const neat = unwrap(inputOf());

    expect(blended.gramsCo2ePerKm).toBeLessThan(neat.gramsCo2ePerKm);
    // A naive "20% ethanol so 20% less carbon" reading would land here.
    expect(blended.gramsCo2ePerKm).toBeGreaterThan(neat.gramsCo2ePerKm * 0.8);
  });

  it("explains the blend, the penalty and the biogenic split separately", () => {
    const text = blended.assumptions.join(" ");

    expect(text).toContain("E20");
    expect(text).toContain("E10 the published efficiency was measured on");
    expect(text).toContain("efficiency is reduced by 3%");
    expect(text).toContain("biogenic");
    expect(text).toContain("IPCC");
    expect(blended.blend).toEqual(e20());
  });

  it("does not assume a blend that was not supplied", () => {
    const neat = unwrap(inputOf());

    expect(neat.blend).toBeNull();
    expect(neat.gramsCo2ePerKm).toBeCloseTo(2310 / PETROL_BLEND, 9);
    expect(neat.assumptions.join(" ")).toContain("No ethanol blend was supplied");
    expect(neat.assumptions.join(" ")).toContain("every litre is counted as fossil petrol");
  });

  it("blends a strong hybrid too — it burns whatever the pump dispenses", () => {
    const hybrid = unwrap(
      inputOf({
        variant: petrolVariant({ fuelType: "hybrid_strong" }),
        factors: [...FACTORS, factor({ fuelType: "hybrid_strong" })],
        blend: e20(),
      }),
    );

    expect(hybrid.appliedGramsCo2ePerUnit).toBe(1968);
  });
});

describe("computeCo2, refusals", () => {
  it("refuses a variant with no real-world efficiency (FR-A7)", () => {
    const result = computeCo2(
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

  it("refuses a variant whose efficiency unit names nothing we can match", () => {
    const result = computeCo2(
      inputOf({ variant: petrolVariant({ efficiencyUnit: null }) }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("efficiency_unit_unknown");
  });

  it("refuses when no factor is on file for the fuel — it does not fall back", () => {
    const result = computeCo2(
      inputOf({ variant: petrolVariant({ fuelType: "hydrogen" }) }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("emission_factor_missing");
    expect(result.reason).toContain("hydrogen");
    expect(result.variantId).toBe("v1");
  });

  it("refuses when the only factor on file is the wrong scope", () => {
    const result = computeCo2(
      inputOf({ factors: [factor({ scope: "tank_to_wheel" })] }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("emission_factor_missing");
  });

  it("refuses to divide a per-litre factor by a per-kWh efficiency", () => {
    const result = computeCo2(
      inputOf({ variant: petrolVariant({ efficiencyUnit: "km/kWh" }) }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("unit_mismatch");
    expect(result.reason).toContain("cannot be divided");
  });

  it("refuses a blend on a fuel that cannot carry one", () => {
    const result = computeCo2(
      inputOf({
        variant: petrolVariant({ fuelType: "diesel" }),
        blend: e20(),
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("blend_not_applicable");
  });

  it("refuses a blend share outside 0-100%", () => {
    const result = computeCo2(inputOf({ blend: e20({ ethanolSharePct: 120 }) }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("blend_invalid");
  });

  it("refuses a penalty that would leave the vehicle no range", () => {
    const result = computeCo2(
      inputOf({ blend: e20({ efficiencyPenaltyPct: 100 }) }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("blend_invalid");
  });

  it("refuses a factor that is not a usable figure", () => {
    const result = computeCo2(
      inputOf({ factors: [factor({ gramsCo2ePerUnit: Number.NaN })] }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("emission_factor_missing");
  });
});
