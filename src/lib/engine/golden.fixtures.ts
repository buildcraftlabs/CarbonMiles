import type { EmissionFactor } from "./co2";
import type { OnRoadFactors } from "./on-road";
import type { PipelineVehicle } from "./pipeline";
import type { RecommendationProfileInput } from "./profile";
import type { EconomicsTables } from "./tco";

/**
 * The golden fixture set — canonical, deliberately round, and owned by the
 * engine.
 *
 * These are not the demo fixtures. The demo's numbers are tuned to make a
 * particular story land on a projector, and tuning them again is a legitimate
 * thing to do to a demo. These exist so a ranking change shows up as a failing
 * assertion, so they are chosen for a different property: **every figure is a
 * round number a reviewer can multiply in their head**. When a snapshot here
 * moves, the diff should be readable, and it should be obvious whether the new
 * value is right.
 *
 * All figures are invented. Nothing here is a market fact, and nothing here
 * carries provenance — see the note in `demo/fixtures.ts` on why inventing
 * provenance for invented numbers is the one thing we never do.
 */

/** Rupees-in-lakhs to paise. Money is paise everywhere past this line. */
const lakhs = (n: number) => Math.round(n * 10_000_000);

const years = <T,>(n: number, f: (year: number) => T): T[] =>
  Array.from({ length: n }, (_, i) => f(i + 1));

const mk = (
  variant: PipelineVehicle["variant"],
  economics: PipelineVehicle["economics"],
  extra: Partial<Pick<PipelineVehicle, "serviceCentreCount" | "resaleLiquidityScore">> = {},
): PipelineVehicle => ({
  variant,
  economics,
  // `=== undefined`, not `??`. These fields carry a meaningful `null` — "we do
  // not know" — and `null ?? 400` would quietly substitute the default for the
  // exact gap the fixture exists to represent.
  serviceCentreCount:
    extra.serviceCentreCount === undefined ? 400 : extra.serviceCentreCount,
  resaleLiquidityScore:
    extra.resaleLiquidityScore === undefined ? 70 : extra.resaleLiquidityScore,
});

const noBattery = {
  batteryKwh: null,
  batteryChemistry: null,
  batteryWarrantyYears: null,
  batteryWarrantyKm: null,
  scheduledServiceCost5yPaise: null,
} as const;

/**
 * Six passenger vehicles across five powertrains, priced so that no two are
 * close enough for a rounding change to reorder them by accident. Names are
 * letters, not words, so nobody can mistake one for a product.
 */
export const PASSENGER_FLEET: readonly PipelineVehicle[] = [
  mk(
    {
      variantId: "p-petrol-hatch",
      modelId: "m-hatch",
      name: "Alpha Hatch (petrol)",
      category: "passenger",
      bodyType: "hatchback",
      status: "active",
      fuelType: "petrol",
      exShowroomPaise: lakhs(6),
      seatingCapacity: 5,
      payloadKg: null,
      realWorldRangeKm: null,
      availableInState: true,
    },
    {
      segment: "hatchback",
      realWorldEfficiencyCity: 15,
      realWorldEfficiencyHighway: 20,
      efficiencyUnit: "kmpl",
      ...noBattery,
    },
  ),
  mk(
    {
      variantId: "p-petrol-sedan",
      modelId: "m-sedan",
      name: "Beta Sedan (petrol)",
      category: "passenger",
      bodyType: "sedan",
      status: "active",
      fuelType: "petrol",
      exShowroomPaise: lakhs(10),
      seatingCapacity: 5,
      payloadKg: null,
      realWorldRangeKm: null,
      availableInState: true,
    },
    {
      segment: "sedan",
      realWorldEfficiencyCity: 12,
      realWorldEfficiencyHighway: 18,
      efficiencyUnit: "kmpl",
      ...noBattery,
    },
  ),
  mk(
    {
      variantId: "p-diesel-suv",
      modelId: "m-suv",
      name: "Gamma SUV (diesel)",
      category: "passenger",
      bodyType: "suv",
      status: "active",
      fuelType: "diesel",
      exShowroomPaise: lakhs(14),
      seatingCapacity: 7,
      payloadKg: null,
      realWorldRangeKm: null,
      availableInState: true,
    },
    {
      segment: "suv",
      realWorldEfficiencyCity: 14,
      realWorldEfficiencyHighway: 20,
      efficiencyUnit: "kmpl",
      ...noBattery,
    },
  ),
  mk(
    {
      variantId: "p-cng-hatch",
      modelId: "m-cng",
      name: "Delta Hatch (CNG)",
      category: "passenger",
      bodyType: "hatchback",
      status: "active",
      fuelType: "cng",
      exShowroomPaise: lakhs(8),
      seatingCapacity: 5,
      payloadKg: null,
      realWorldRangeKm: null,
      availableInState: true,
    },
    {
      segment: "hatchback",
      realWorldEfficiencyCity: 24,
      realWorldEfficiencyHighway: 28,
      efficiencyUnit: "km/kg",
      ...noBattery,
    },
  ),
  mk(
    {
      variantId: "p-electric",
      modelId: "m-ev",
      name: "Epsilon EV",
      category: "passenger",
      bodyType: "hatchback",
      status: "active",
      fuelType: "electric",
      exShowroomPaise: lakhs(12),
      seatingCapacity: 5,
      payloadKg: null,
      realWorldRangeKm: 300,
      availableInState: true,
    },
    {
      segment: "hatchback",
      realWorldEfficiencyCity: 6,
      realWorldEfficiencyHighway: 5,
      efficiencyUnit: "km/kwh",
      batteryKwh: 40,
      batteryChemistry: "lfp",
      batteryWarrantyYears: 8,
      batteryWarrantyKm: 160_000,
      scheduledServiceCost5yPaise: null,
    },
  ),
  mk(
    {
      variantId: "p-hybrid",
      modelId: "m-hybrid",
      name: "Zeta Hybrid",
      category: "passenger",
      bodyType: "sedan",
      status: "active",
      fuelType: "hybrid_strong",
      exShowroomPaise: lakhs(16),
      seatingCapacity: 5,
      payloadKg: null,
      realWorldRangeKm: null,
      availableInState: true,
    },
    {
      segment: "sedan",
      realWorldEfficiencyCity: 25,
      realWorldEfficiencyHighway: 22,
      efficiencyUnit: "kmpl",
      ...noBattery,
    },
    // A deliberate data gap: reliability and resale must score `null` for this
    // vehicle and its weight must redistribute, never default to zero.
    { serviceCentreCount: null, resaleLiquidityScore: null },
  ),
];

/** Two commercial vehicles, so stage 2c has something to compute a margin on. */
export const COMMERCIAL_FLEET: readonly PipelineVehicle[] = [
  mk(
    {
      variantId: "c-mini-truck",
      modelId: "m-mini",
      name: "Kappa Mini Truck (diesel)",
      category: "commercial",
      bodyType: "mini_truck",
      status: "active",
      fuelType: "diesel",
      exShowroomPaise: lakhs(7),
      seatingCapacity: 2,
      payloadKg: 1_000,
      realWorldRangeKm: null,
      availableInState: true,
    },
    {
      segment: "mini_truck",
      realWorldEfficiencyCity: 12,
      realWorldEfficiencyHighway: 16,
      efficiencyUnit: "kmpl",
      ...noBattery,
    },
  ),
  mk(
    {
      variantId: "c-lcv",
      modelId: "m-lcv",
      name: "Lambda LCV (diesel)",
      category: "commercial",
      bodyType: "lcv",
      status: "active",
      fuelType: "diesel",
      exShowroomPaise: lakhs(12),
      seatingCapacity: 3,
      payloadKg: 2_500,
      realWorldRangeKm: null,
      availableInState: true,
    },
    {
      segment: "lcv",
      realWorldEfficiencyCity: 8,
      realWorldEfficiencyHighway: 12,
      efficiencyUnit: "kmpl",
      ...noBattery,
    },
  ),
];

export const onRoadFactors: readonly OnRoadFactors[] = [
  {
    stateCode: "KA",
    category: "passenger",
    fuelType: null,
    priceBandMinPaise: 0,
    priceBandMaxPaise: null,
    roadTaxPct: 10,
    registrationFeePaise: 100_000,
    insurancePct: 3,
    otherLevyPaise: 0,
    effectiveFrom: "2026-01-01",
  },
  {
    stateCode: "KA",
    category: "commercial",
    fuelType: null,
    priceBandMinPaise: 0,
    priceBandMaxPaise: null,
    roadTaxPct: 8,
    registrationFeePaise: 100_000,
    insurancePct: 4,
    otherLevyPaise: 0,
    effectiveFrom: "2026-01-01",
  },
];

/**
 * Maintenance and resale curves match on segment AND fuelType AND category
 * together, and a missing combination fails that whole vehicle — which would
 * thin a shortlist silently. So the fixture emits the full cross-product.
 */
const PASSENGER_SEGMENTS = ["hatchback", "sedan", "suv"] as const;
const COMMERCIAL_SEGMENTS = ["mini_truck", "lcv"] as const;
const FUELS = ["petrol", "diesel", "cng", "electric", "hybrid_strong"] as const;

/** Round by construction: 10 points of residual lost per year, from 90. */
const residualPct = (ageYears: number) => 90 - ageYears * 10;

export const tables: EconomicsTables = {
  energyPrices: {
    petrol: { pricePaise: 10_000, unit: "litre", asOf: "2026-01-01" },
    diesel: { pricePaise: 9_000, unit: "litre", asOf: "2026-01-01" },
    cng: { pricePaise: 8_000, unit: "kg", asOf: "2026-01-01" },
    electric: { pricePaise: 800, unit: "kwh", asOf: "2026-01-01" },
    hybrid_strong: { pricePaise: 10_000, unit: "litre", asOf: "2026-01-01" },
  },
  maintenance: [
    ...PASSENGER_SEGMENTS.flatMap((segment) =>
      FUELS.flatMap((fuelType) =>
        years(10, (year) => ({
          segment,
          fuelType,
          category: "passenger" as const,
          ownershipYear: year,
          costPaise: (fuelType === "electric" ? 200_000 : 400_000) + year * 50_000,
          referenceAnnualKm: 12_000,
          marginalCostPaisePerKm: fuelType === "electric" ? 50 : 100,
        })),
      ),
    ),
    ...COMMERCIAL_SEGMENTS.flatMap((segment) =>
      FUELS.flatMap((fuelType) =>
        years(10, (year) => ({
          segment,
          fuelType,
          category: "commercial" as const,
          ownershipYear: year,
          costPaise: 800_000 + year * 100_000,
          referenceAnnualKm: 40_000,
          marginalCostPaisePerKm: 150,
        })),
      ),
    ),
  ],
  resale: [
    ...PASSENGER_SEGMENTS.flatMap((segment) =>
      FUELS.flatMap((fuelType) =>
        years(10, (year) => ({
          segment,
          fuelType,
          category: "passenger" as const,
          ageYears: year,
          residualPct: residualPct(year),
        })),
      ),
    ),
    ...COMMERCIAL_SEGMENTS.flatMap((segment) =>
      FUELS.flatMap((fuelType) =>
        years(10, (year) => ({
          segment,
          fuelType,
          category: "commercial" as const,
          ageYears: year,
          residualPct: residualPct(year),
        })),
      ),
    ),
  ],
  batteries: [
    {
      chemistry: "lfp",
      pricePaisePerKwh: 800_000,
      annualDegradationPct: 3,
      replacementThresholdPct: 70,
    },
  ],
  financeRates: [
    { category: "passenger", fuelType: null, annualRatePct: 10, processingFeePct: 1 },
    { category: "commercial", fuelType: null, annualRatePct: 12, processingFeePct: 1 },
  ],
  discountRatePct: 5,
};

/**
 * The factor `unit` must match the denominator of the variant's
 * `efficiencyUnit` (kmpl → litre, km/kg → kg, km/kWh → kWh) or the CO₂
 * calculation fails and the environment sub-score quietly disappears.
 */
export const emissionFactors: readonly EmissionFactor[] = [
  {
    fuelType: "petrol",
    gramsCo2ePerUnit: 2_800,
    unit: "litre",
    scope: "well_to_wheel",
    stateCode: null,
    asOf: "2026-01-01",
  },
  {
    fuelType: "diesel",
    gramsCo2ePerUnit: 3_000,
    unit: "litre",
    scope: "well_to_wheel",
    stateCode: null,
    asOf: "2026-01-01",
  },
  {
    fuelType: "cng",
    gramsCo2ePerUnit: 2_500,
    unit: "kg",
    scope: "well_to_wheel",
    stateCode: null,
    asOf: "2026-01-01",
  },
  {
    fuelType: "electric",
    gramsCo2ePerUnit: 700,
    unit: "kwh",
    scope: "well_to_wheel",
    stateCode: "KA",
    asOf: "2026-01-01",
  },
  {
    fuelType: "hybrid_strong",
    gramsCo2ePerUnit: 2_800,
    unit: "litre",
    scope: "well_to_wheel",
    stateCode: null,
    asOf: "2026-01-01",
  },
];

/** A well-served city: nothing is gated, so rankings turn on economics. */
export const infra = {
  petrol: { type: "petrol" as const, stationCount: 500, percentile: 90, confidenceScore: 90 },
  diesel: { type: "diesel" as const, stationCount: 500, percentile: 90, confidenceScore: 90 },
  cng: { type: "cng" as const, stationCount: 100, percentile: 70, confidenceScore: 80 },
  ev_dc: { type: "ev_dc" as const, stationCount: 80, percentile: 70, confidenceScore: 70 },
};

/** A town with no CNG and almost no fast charging — the gates should fire. */
export const thinInfra = {
  petrol: { type: "petrol" as const, stationCount: 60, percentile: 40, confidenceScore: 80 },
  diesel: { type: "diesel" as const, stationCount: 60, percentile: 40, confidenceScore: 80 },
  cng: { type: "cng" as const, stationCount: 0, percentile: 2, confidenceScore: 50 },
  ev_dc: { type: "ev_dc" as const, stationCount: 1, percentile: 5, confidenceScore: 30 },
};

/**
 * The canonical profiles.
 *
 * Each is a person, not a parameter sweep: they exist to pin the engine's
 * behaviour on the handful of decisions the product is actually judged on —
 * does a short-distance buyer get told to keep it cheap, does a high-mileage
 * one get pushed toward running cost, does an eco-first one get the EV, and
 * does a buyer with nowhere to charge stop being offered one.
 */
export const CANONICAL_PROFILES: Readonly<
  Record<string, RecommendationProfileInput>
> = {
  /** Low distance, tight budget. Acquisition dominates; running cost barely matters. */
  budgetCityCommuter: {
    category: "passenger",
    location: { stateCode: "KA" },
    budget: { maxOnRoadPaise: lakhs(12) },
    usage: { dailyKm: 15, monthlyKm: 400, typicalTripKm: 8, citySharePct: 95 },
    charging: { homeCharging: false },
    preferences: {},
    financing: { mode: "cash" },
    ownershipYears: 5,
    passengers: 4,
    cargoNeed: "light",
  },

  /** 3,000 km a month. Fuel is the whole decision. */
  highMileageHighway: {
    category: "passenger",
    location: { stateCode: "KA" },
    budget: { maxOnRoadPaise: lakhs(20) },
    usage: { dailyKm: 120, monthlyKm: 3_000, typicalTripKm: 200, citySharePct: 20 },
    charging: { homeCharging: false },
    preferences: {},
    financing: { mode: "loan", downPaymentPct: 20, tenureMonths: 60 },
    ownershipYears: 7,
    passengers: 5,
    cargoNeed: "moderate",
  },

  /** Can charge at home and says emissions matter most. */
  ecoFirstWithHomeCharging: {
    category: "passenger",
    location: { stateCode: "KA" },
    budget: { maxOnRoadPaise: lakhs(20) },
    usage: { dailyKm: 50, monthlyKm: 1_500, typicalTripKm: 30, citySharePct: 80 },
    charging: { homeCharging: true },
    preferences: { environmentWeight: 0.5 },
    financing: { mode: "cash" },
    ownershipYears: 8,
    passengers: 5,
    cargoNeed: "light",
  },

  /** Seven seats, and the requirement is not negotiable. */
  largeFamily: {
    category: "passenger",
    location: { stateCode: "KA" },
    budget: { maxOnRoadPaise: lakhs(20) },
    usage: { dailyKm: 40, monthlyKm: 1_200, typicalTripKm: 60, citySharePct: 60 },
    charging: { homeCharging: true },
    preferences: {},
    financing: { mode: "cash" },
    ownershipYears: 6,
    passengers: 7,
    cargoNeed: "heavy",
  },

  /** An owner-driver hauling a tonne, who needs a payback month. */
  lastMileOperator: {
    category: "commercial",
    location: { stateCode: "KA" },
    budget: { maxOnRoadPaise: lakhs(15) },
    usage: { dailyKm: 100, monthlyKm: 2_600, typicalTripKm: 20, citySharePct: 90 },
    charging: { homeCharging: false },
    preferences: {},
    financing: { mode: "loan", downPaymentPct: 25, tenureMonths: 48 },
    ownershipYears: 6,
    payloadKg: 800,
    revenuePaisePerKm: 2_500,
    driverCostPaisePerMonth: 0,
    dutyCycle: "last_mile",
    operatingDaysPerMonth: 26,
  },
};

/** Fixed, never a clock — a golden run that moves with the date is not golden. */
export const AS_OF = "2026-06-01";
export const ENGINE_VERSION = "engine-golden";
