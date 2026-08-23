/**
 * ILLUSTRATIVE SAMPLE DATA — NOT REAL MARKET DATA.
 *
 * Every figure below is invented. The vehicle names are deliberately generic
 * (Aster, Borea, Cirrus, Dune, Solis, Zenith, Orion, Vega) and correspond to no
 * real manufacturer or model, so that nothing here can be mistaken for a
 * sourced fact about a product a person could actually buy.
 *
 * This file exists so the deterministic engine can be demonstrated end to end
 * before the catalogue is seeded. The engine is real; the catalogue is not.
 * Nothing here carries a `fact_provenance` row, and deliberately so — inventing
 * provenance for invented numbers is exactly the failure the provenance rule
 * exists to prevent. Stage 5 reports the resulting gap honestly instead.
 *
 * No `src/db/` import appears anywhere in this module graph, by design.
 */

import type { CandidateVariant, InfraSnapshot } from "@/lib/engine/candidate";
import type { EmissionFactor } from "@/lib/engine/co2";
import type { OnRoadFactors } from "@/lib/engine/on-road";
import type { PipelineVehicle } from "@/lib/engine/pipeline";
import type { RecommendationProfileInput } from "@/lib/engine/profile";
import type { EconomicsTables } from "@/lib/engine/tco";

/** Rupees-in-lakhs to paise. Money is paise everywhere past this line. */
const lakhs = (n: number) => Math.round(n * 10_000_000);

const years = <T,>(n: number, f: (year: number) => T): T[] =>
  Array.from({ length: n }, (_, i) => f(i + 1));

/** A demo vehicle is just a pipeline vehicle; the engine owns the shape. */
export type DemoVehicle = PipelineVehicle;

const mk = (
  v: Partial<CandidateVariant> &
    Pick<CandidateVariant, "variantId" | "modelId" | "name">,
  e: Partial<DemoVehicle["economics"]> &
    Pick<DemoVehicle["economics"], "segment">,
  extra: {
    serviceCentreCount?: number | null;
    resaleLiquidityScore?: number | null;
  } = {},
): DemoVehicle => ({
  variant: {
    category: "passenger",
    bodyType: "hatchback",
    status: "active",
    fuelType: "petrol",
    exShowroomPaise: lakhs(8),
    seatingCapacity: 5,
    payloadKg: null,
    realWorldRangeKm: null,
    availableInState: true,
    ...v,
  },
  economics: {
    realWorldEfficiencyCity: 18,
    realWorldEfficiencyHighway: 22,
    efficiencyUnit: "kmpl",
    batteryKwh: null,
    batteryChemistry: null,
    batteryWarrantyYears: null,
    batteryWarrantyKm: null,
    scheduledServiceCost5yPaise: null,
    ...e,
  },
  serviceCentreCount:
    extra.serviceCentreCount === undefined ? 300 : extra.serviceCentreCount,
  resaleLiquidityScore:
    extra.resaleLiquidityScore === undefined ? 70 : extra.resaleLiquidityScore,
});

/**
 * Nine invented vehicles across five powertrains, so the comparison has
 * something to compare. Three are built to be excluded by stage 1 — a demo that
 * only shows what survived is hiding half the engine.
 */
export const FLEET: readonly DemoVehicle[] = [
  mk(
    {
      variantId: "aster-vx",
      modelId: "aster",
      name: "Aster 1.2 VX (petrol)",
      exShowroomPaise: lakhs(7.5),
    },
    { segment: "premium_hatchback" },
  ),
  mk(
    {
      variantId: "aster-zx",
      modelId: "aster",
      name: "Aster 1.2 ZX (petrol)",
      exShowroomPaise: lakhs(8.4),
    },
    {
      segment: "premium_hatchback",
      realWorldEfficiencyCity: 17,
      realWorldEfficiencyHighway: 21,
    },
  ),
  // A third variant of the same model: exists to be capped out by stage 4's
  // MAX_VARIANTS_PER_MODEL, which is its own demo beat.
  mk(
    {
      variantId: "aster-zx-plus",
      modelId: "aster",
      name: "Aster 1.2 ZX+ (petrol)",
      exShowroomPaise: lakhs(9.1),
    },
    {
      segment: "premium_hatchback",
      realWorldEfficiencyCity: 16.5,
      realWorldEfficiencyHighway: 20,
    },
  ),
  mk(
    {
      variantId: "borea-ev",
      modelId: "borea",
      name: "Borea 45 (electric)",
      fuelType: "electric",
      bodyType: "suv",
      exShowroomPaise: lakhs(13),
      realWorldRangeKm: 310,
    },
    {
      segment: "compact_suv",
      realWorldEfficiencyCity: 6.2,
      realWorldEfficiencyHighway: 5.4,
      efficiencyUnit: "km/kwh",
      batteryKwh: 45,
      batteryChemistry: "lfp",
      batteryWarrantyYears: 8,
      batteryWarrantyKm: 160_000,
    },
    { resaleLiquidityScore: 45 },
  ),
  mk(
    {
      variantId: "cirrus-cng",
      modelId: "cirrus",
      name: "Cirrus 1.0 CNG",
      fuelType: "cng",
      exShowroomPaise: lakhs(8.6),
    },
    {
      segment: "premium_hatchback",
      realWorldEfficiencyCity: 26,
      realWorldEfficiencyHighway: 30,
      efficiencyUnit: "km/kg",
    },
  ),
  mk(
    {
      variantId: "dune-dsl",
      modelId: "dune",
      name: "Dune 1.5 (diesel)",
      fuelType: "diesel",
      bodyType: "suv",
      exShowroomPaise: lakhs(11.2),
    },
    {
      segment: "compact_suv",
      realWorldEfficiencyCity: 19,
      realWorldEfficiencyHighway: 24,
    },
    { serviceCentreCount: 120 },
  ),
  /**
   * THE DATA GAP. A newly-launched strong hybrid we hold no service-network
   * count and no resale-liquidity reading for. Stage 3 leaves `reliability` and
   * `resale` unscored for it rather than substituting a midpoint, and the page
   * must render those as "unknown" — never as zero, which would silently punish
   * a vehicle for our own missing data.
   */
  mk(
    {
      variantId: "solis-hev",
      modelId: "solis",
      name: "Solis 1.5 (strong hybrid)",
      fuelType: "hybrid_strong",
      bodyType: "sedan",
      exShowroomPaise: lakhs(12.4),
    },
    {
      segment: "compact_suv",
      realWorldEfficiencyCity: 24,
      realWorldEfficiencyHighway: 23,
    },
    { serviceCentreCount: null, resaleLiquidityScore: null },
  ),

  // ---- built to be excluded by stage 1, each by a different filter ----
  mk(
    {
      variantId: "zenith-lux",
      modelId: "zenith",
      name: "Zenith 2.0 Luxe (petrol)",
      exShowroomPaise: lakhs(24),
      bodyType: "sedan",
    },
    { segment: "executive_sedan" },
  ),
  mk(
    {
      variantId: "orion-old",
      modelId: "orion",
      name: "Orion 1.4 (discontinued)",
      status: "discontinued",
    },
    { segment: "premium_hatchback" },
  ),
  mk(
    {
      variantId: "vega-4",
      modelId: "vega",
      name: "Vega 4-seat MPV",
      seatingCapacity: 4,
      bodyType: "mpv",
      exShowroomPaise: lakhs(10),
    },
    { segment: "mpv" },
  ),
];

export const onRoadFactors: readonly OnRoadFactors[] = [
  {
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
  },
];

/**
 * Maintenance and resale curves are matched on segment AND fuelType AND
 * category together. A missing combination fails that whole vehicle, which
 * would thin the shortlist silently — so emit the full cross-product.
 */
const SEGMENTS = [
  "premium_hatchback",
  "compact_suv",
  "executive_sedan",
  "mpv",
] as const;

const FUELS = ["petrol", "diesel", "cng", "electric", "hybrid_strong"] as const;

const RESIDUALS = [85, 75, 65, 57, 50];

export const tables: EconomicsTables = {
  energyPrices: {
    petrol: { pricePaise: 10_600, unit: "litre", asOf: "2026-08-01" },
    diesel: { pricePaise: 9_400, unit: "litre", asOf: "2026-08-01" },
    cng: { pricePaise: 8_700, unit: "kg", asOf: "2026-08-01" },
    electric: { pricePaise: 850, unit: "kwh", asOf: "2026-08-01" },
    // A strong hybrid burns whatever the petrol pump dispenses.
    hybrid_strong: { pricePaise: 10_600, unit: "litre", asOf: "2026-08-01" },
  },
  maintenance: SEGMENTS.flatMap((segment) =>
    FUELS.flatMap((fuelType) =>
      years(5, (year) => ({
        segment,
        fuelType,
        category: "passenger" as const,
        ownershipYear: year,
        costPaise:
          (fuelType === "electric" ? 300_000 : 500_000) + year * 40_000,
        referenceAnnualKm: 12_000,
        marginalCostPaisePerKm: fuelType === "electric" ? 60 : 100,
      })),
    ),
  ),
  resale: SEGMENTS.flatMap((segment) =>
    FUELS.flatMap((fuelType) =>
      years(5, (year) => ({
        segment,
        fuelType,
        category: "passenger" as const,
        ageYears: year,
        residualPct:
          fuelType === "electric" ? RESIDUALS[year - 1] - 8 : RESIDUALS[year - 1],
      })),
    ),
  ),
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
  discountRatePct: 6,
};

/**
 * The factor `unit` must match the denominator of the variant's
 * `efficiencyUnit` (kmpl -> litre, km/kg -> kg, km/kwh -> kwh) or the CO2
 * calculation fails and the environment sub-score quietly disappears.
 */
export const emissionFactors: readonly EmissionFactor[] = [
  {
    fuelType: "petrol",
    gramsCo2ePerUnit: 2_760,
    unit: "litre",
    scope: "well_to_wheel",
    stateCode: null,
    asOf: "2026-01-01",
  },
  {
    fuelType: "diesel",
    gramsCo2ePerUnit: 3_120,
    unit: "litre",
    scope: "well_to_wheel",
    stateCode: null,
    asOf: "2026-01-01",
  },
  {
    fuelType: "cng",
    gramsCo2ePerUnit: 2_540,
    unit: "kg",
    scope: "well_to_wheel",
    stateCode: null,
    asOf: "2026-01-01",
  },
  {
    fuelType: "electric",
    gramsCo2ePerUnit: 710,
    unit: "kwh",
    scope: "well_to_wheel",
    stateCode: "MH",
    asOf: "2026-01-01",
  },
  {
    fuelType: "hybrid_strong",
    gramsCo2ePerUnit: 2_760,
    unit: "litre",
    scope: "well_to_wheel",
    stateCode: null,
    asOf: "2026-01-01",
  },
];

export const infra: InfraSnapshot = {
  petrol: { type: "petrol", stationCount: 480, percentile: 88, confidenceScore: 90 },
  diesel: { type: "diesel", stationCount: 470, percentile: 87, confidenceScore: 90 },
  cng: { type: "cng", stationCount: 96, percentile: 72, confidenceScore: 75 },
  ev_dc: { type: "ev_dc", stationCount: 61, percentile: 68, confidenceScore: 66 },
};

/** The question the demo answers, in the engine's own input shape. */
export const profileInput: RecommendationProfileInput = {
  category: "passenger",
  location: { stateCode: "MH" },
  budget: { maxOnRoadPaise: lakhs(15) },
  usage: { dailyKm: 40, monthlyKm: 1_400, typicalTripKm: 60, citySharePct: 70 },
  charging: { homeCharging: true },
  preferences: { environmentWeight: 0.35, excludedFuelTypes: [] },
  financing: { mode: "loan", downPaymentPct: 20, tenureMonths: 60 },
  ownershipYears: 5,
  passengers: 5,
  cargoNeed: "moderate",
};

/**
 * Fixed, never `new Date()`. The engine takes `asOf` as an input rather than
 * reading a clock so a run is reproducible — and it keeps the demo identical on
 * every reload, which matters when it is on a projector.
 */
export const AS_OF = "2026-08-23";
export const ENGINE_VERSION = "engine-2026.08.1";
