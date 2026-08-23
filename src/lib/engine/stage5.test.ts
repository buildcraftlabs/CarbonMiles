import { describe, expect, it } from "vitest";

import { confidenceLevel, sourceTier } from "@/db/schema/enums";

import type { CandidateVariant, Exclusion } from "./candidate";
import type { Co2Breakdown, EmissionFactor, EthanolBlend } from "./co2";
import type { CommercialEconomics, CommercialScenario } from "./commercial";
import type { FuelType } from "./enums";
import type { OnRoadFactors, OnRoadPrice } from "./on-road";
import type { RecommendationProfile } from "./profile";
import type { Stage1Result } from "./stage1";
import {
  runStage3,
  type ScoreDimension,
  type ScoredCandidate,
  type ScoringInput,
  type Stage3Result,
  type SubScore,
} from "./stage3";
import {
  runStage4,
  type Omission,
  type RankedCandidate,
  type Stage4Result,
} from "./stage4";
import {
  CONFIDENCE_LEVELS,
  runStage5,
  SOURCE_TIERS,
  type ProvenanceRecord,
  type Stage5Input,
} from "./stage5";
import type { TcoBreakdown } from "./tco";

const lakhs = (n: number) => Math.round(n * 10_000_000);

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

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

const price: OnRoadPrice = {
  exShowroomPaise: lakhs(8),
  roadTaxPaise: lakhs(0.88),
  registrationFeePaise: 60_000,
  insurancePaise: lakhs(0.24),
  otherLevyPaise: 0,
  onRoadPaise: lakhs(9.12) + 60_000,
  factors: onRoadFactors,
};

const tco = (variantId: string, totalPaise = lakhs(12)): TcoBreakdown => ({
  variantId,
  ownershipYears: 5,
  totalKm: 72_000,
  acquisitionPaise: lakhs(9),
  energyPaise: lakhs(3),
  maintenancePaise: lakhs(1),
  insuranceRenewalPaise: 50_000_000,
  financingInterestPaise: 0,
  batteryReplacementPaise: 0,
  resaleNominalPaise: lakhs(4),
  resaleCreditPaise: lakhs(3),
  totalPaise,
  costPaisePerKm: totalPaise / 72_000,
  yearly: [
    {
      year: 1,
      energyPaise: lakhs(0.6),
      maintenancePaise: lakhs(0.2),
      insurancePaise: 10_000_000,
      interestPaise: 0,
      batteryPaise: 0,
      totalPaise: lakhs(0.8) + 10_000_000,
    },
  ],
  assumptions: [`Service pricing for ${variantId} is taken from the segment curve.`],
});

const emissionFactor: EmissionFactor = {
  fuelType: "petrol",
  gramsCo2ePerUnit: 2_760,
  unit: "litre",
  scope: "well_to_wheel",
  stateCode: null,
  asOf: "2026-01-01",
};

const co2 = (variantId: string, gramsPerKm = 148.5): Co2Breakdown => ({
  variantId,
  ownershipYears: 5,
  totalKm: 72_000,
  gramsCo2ePerKm: gramsPerKm,
  biogenicGramsCo2PerKm: 0,
  annualGramsCo2e: Math.round(gramsPerKm * 14_400),
  horizonGramsCo2e: Math.round(gramsPerKm * 72_000),
  horizonBiogenicGramsCo2: 0,
  effectiveEfficiency: 18.6,
  efficiencyUnit: "kmpl",
  appliedGramsCo2ePerUnit: 2_760,
  scope: "well_to_wheel",
  factor: emissionFactor,
  blend: null,
  assumptions: ["No ethanol blend was supplied, so neat fossil petrol was assumed."],
});

const variant = (
  variantId: string,
  modelId: string,
  fuelType: FuelType = "petrol",
): CandidateVariant => ({
  variantId,
  modelId,
  name: `${variantId} (${modelId})`,
  category: "passenger",
  bodyType: "hatchback",
  status: "active",
  fuelType,
  exShowroomPaise: lakhs(8),
  seatingCapacity: 5,
  payloadKg: null,
  realWorldRangeKm: null,
  availableInState: true,
});

const sub = (
  dimension: ScoreDimension,
  score: number | null,
  raw: number | null,
  weight: number,
  extra: Partial<SubScore> = {},
): SubScore => ({
  dimension,
  score,
  raw,
  unit: dimension === "cost" ? "paise" : "index",
  direction: dimension === "cost" ? "lower_is_better" : "higher_is_better",
  range: raw === null ? null : { min: 0, max: 100 },
  discriminating: true,
  weight,
  ...extra,
});

const profile: RecommendationProfile = {
  category: "passenger",
  location: { stateCode: "MH" },
  budget: { maxOnRoadPaise: lakhs(12) },
  usage: { dailyKm: 30, monthlyKm: 1_200, typicalTripKm: 25, citySharePct: 70 },
  charging: { homeCharging: false, tariffKind: "domestic_slab" },
  preferences: { environmentWeight: 0.25, excludedFuelTypes: [] },
  financing: { mode: "cash" },
  ownershipYears: 5,
  passengers: 4,
  cargoNeed: "light",
};

interface Spec {
  id: string;
  model?: string;
  fuel?: FuelType;
  score: number;
  subScores?: SubScore[];
  totalPaise?: number;
  co2?: Co2Breakdown | null;
  commercial?: CommercialEconomics | null;
}

const candidateFor = (spec: Spec): ScoringInput => ({
  variant: variant(spec.id, spec.model ?? `m-${spec.id}`, spec.fuel ?? "petrol"),
  price,
  tco: tco(spec.id, spec.totalPaise),
  co2: spec.co2 === undefined ? co2(spec.id) : spec.co2,
  commercial: spec.commercial ?? null,
  serviceCentreCount: 300,
  resaleLiquidityScore: 70,
});

const scoredFor = (spec: Spec): ScoredCandidate => ({
  variantId: spec.id,
  name: variant(spec.id, spec.model ?? `m-${spec.id}`).name,
  totalScore: spec.score,
  subScores: spec.subScores ?? [
    sub("cost", 80, lakhs(12), 0.5),
    sub("reliability", 60, 300, 0.3),
    sub("resale", 50, 70, 0.2),
  ],
  unscored: [],
});

const rankedFor = (spec: Spec, rank: number): RankedCandidate => ({
  rank,
  variantId: spec.id,
  modelId: spec.model ?? `m-${spec.id}`,
  name: variant(spec.id, spec.model ?? `m-${spec.id}`).name,
  fuelType: spec.fuel ?? "petrol",
  totalScore: spec.score,
  selectedBy: rank === 1 ? "top_pick" : "score",
  bestInFuel: rank === 1,
});

/**
 * Builds a stage-5 input from a compact spec. `scored` is deliberately handed
 * over **shuffled** relative to `ranked` by default, because stage 3 returns
 * input order and stage 4 returns rank order — a stage 5 that joined by index
 * would pass a test built on two aligned arrays and fail in production.
 */
const build = (
  specs: readonly Spec[],
  overrides: Partial<Stage5Input> = {},
): Stage5Input => {
  const ranked = specs.map((spec, i) => rankedFor(spec, i + 1));
  const stage4: Extract<Stage4Result, { ok: true }> = {
    ok: true,
    ranked,
    omitted: [],
    assumptions: [],
  };
  const stage3: Stage3Result = {
    scored: [...specs].reverse().map(scoredFor),
    weights: { cost: 0.5, reliability: 0.3, resale: 0.2 },
    weightBasis: ["Passenger profile: total cost of ownership carries the most weight."],
    assumptions: [],
  };
  const stage1: Stage1Result = { candidates: [], exclusions: [], assumptions: [] };

  return {
    profile,
    asOf: "2026-08-23",
    engineVersion: "engine-2026.08.1",
    stage1,
    candidates: [...specs].reverse().map(candidateFor),
    stage3,
    stage4,
    ...overrides,
  };
};

const run = (input: Stage5Input) => {
  const result = runStage5(input);
  if (!result.ok) throw new Error(`stage 5 failed: ${result.reason}`);
  return result.payload;
};

const two: Spec[] = [
  { id: "win", score: 82 },
  { id: "second", score: 74 },
];

/* -------------------------------------------------------------------------- */

describe("engine provenance enums mirror the database enums", () => {
  it("confidence_level", () => {
    expect(CONFIDENCE_LEVELS).toEqual(confidenceLevel.enumValues);
  });

  it("source_tier", () => {
    expect(SOURCE_TIERS).toEqual(sourceTier.enumValues);
  });
});

describe("runStage5 assembly", () => {
  it("joins candidates and scores by id, not by array position", () => {
    const payload = run(build(two));

    expect(payload.data.vehicles.map((v) => v.variantId)).toEqual(["win", "second"]);
    expect(payload.data.vehicles[0].tco.variantId).toBe("win");
    expect(payload.data.vehicles[0].co2?.variantId).toBe("win");
    expect(payload.data.vehicles[1].tco.variantId).toBe("second");
  });

  it("carries the total score from stage 4 rather than recomputing it", () => {
    const payload = run(build(two));

    expect(payload.data.vehicles.map((v) => v.totalScore)).toEqual([82, 74]);
  });

  it("carries the yearly series, the on-road factors row and the emission factor untouched", () => {
    const [vehicle] = run(build(two)).data.vehicles;

    expect(vehicle.tco.yearly).toHaveLength(1);
    expect(vehicle.price.factors).toBe(onRoadFactors);
    expect(vehicle.co2?.factor).toBe(emissionFactor);
    expect(vehicle.co2?.effectiveEfficiency).toBe(18.6);
  });

  it("keeps rate figures byte-identical, unrounded, as the earlier stages left them", () => {
    const payload = run(build([{ id: "win", score: 82, totalPaise: 1_234_567 }]));
    const [vehicle] = payload.data.vehicles;

    expect(vehicle.tco.costPaisePerKm).toBe(1_234_567 / 72_000);
    expect(vehicle.co2?.gramsCo2ePerKm).toBe(148.5);
  });

  it("fails typed rather than ranking a vehicle it holds no candidate for", () => {
    const input = build(two);
    const result = runStage5({
      ...input,
      candidates: input.candidates.filter((c) => c.variant.variantId !== "second"),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("candidate_missing");
      expect(result.reason).toContain("second");
    }
  });

  it("fails typed rather than ranking a vehicle it holds no score for", () => {
    const input = build(two);
    const result = runStage5({
      ...input,
      stage3: { ...input.stage3, scored: input.stage3.scored.slice(0, 1) },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("score_missing");
  });

  it("records the run so it can be replayed, and never reads a clock", () => {
    const { run: meta } = run(build(two)).data;

    expect(meta.asOf).toBe("2026-08-23");
    expect(meta.engineVersion).toBe("engine-2026.08.1");
    expect(meta.profile).toBe(profile);
    expect(meta.candidateCount).toBe(2);
    expect(meta.rankedCount).toBe(2);
  });

  it("exposes the persona weights and their basis verbatim", () => {
    const payload = run(build(two));

    expect(payload.data.weights).toEqual({ cost: 0.5, reliability: 0.3, resale: 0.2 });
    expect(payload.data.weightBasis[0]).toContain("Passenger profile");
  });

  it("gives every rank past the first a break-even month against the top pick", () => {
    const payload = run(
      build([
        { id: "win", score: 82, totalPaise: lakhs(14) },
        { id: "second", score: 74, totalPaise: lakhs(11) },
      ]),
    );

    expect(payload.data.vehicles[0].breakEvenMonthVsTopPick).toBeUndefined();
    expect(payload.data.vehicles[1].breakEvenMonthVsTopPick).toBe(0);
  });

  it("reports never paying back as null rather than as a sentinel", () => {
    const cheapRunner: TcoBreakdown = {
      ...tco("second"),
      acquisitionPaise: lakhs(30),
      yearly: [
        {
          year: 1,
          energyPaise: lakhs(1),
          maintenancePaise: 0,
          insurancePaise: 0,
          interestPaise: 0,
          batteryPaise: 0,
          totalPaise: lakhs(1),
        },
      ],
    };
    const input = build(two);
    const payload = run({
      ...input,
      candidates: input.candidates.map((c) =>
        c.variant.variantId === "second" ? { ...c, tco: cheapRunner } : c,
      ),
    });

    expect(payload.data.vehicles[1].breakEvenMonthVsTopPick).toBeNull();
  });

  it("returns an empty result set rather than failing when nothing ranked", () => {
    const input = build([]);
    const payload = run(input);

    expect(payload.data.vehicles).toEqual([]);
    expect(payload.data.contrast).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */

const provenanceFor = (
  entityTable: string,
  entityId: string,
  field: string,
  sourceId = "src-1",
): ProvenanceRecord => ({
  entityTable,
  entityId,
  field,
  sourceId,
  sourceSlug: sourceId === "src-1" ? "morth" : "cea",
  sourceName: sourceId === "src-1" ? "Ministry of Road Transport" : "Central Electricity Authority",
  tier: "government",
  sourceUrl: "https://example.invalid/doc",
  excerpt: "row as published",
  confidence: "high",
  verifiedAt: "2026-06-01",
});

describe("runStage5 attribution", () => {
  it("attaches the source id to a number a provenance row covers", () => {
    const payload = run(
      build(two, {
        provenance: [provenanceFor("vehicle_variants", "win", "ex_showroom_paise")],
      }),
    );

    const exShowroom = payload.data.vehicles[0].attributions.find(
      (a) => a.key === "price.exShowroomPaise",
    );
    expect(exShowroom?.attribution).toBe("sourced_fact");
    expect(exShowroom?.sourceIds).toEqual(["src-1"]);
  });

  it("resolves a reference-table number through the row id the caller supplies", () => {
    const payload = run(
      build(two, {
        references: { win: { onRoadFactorsId: "sorf-1" } },
        provenance: [provenanceFor("state_on_road_factors", "sorf-1", "road_tax_pct")],
      }),
    );

    const roadTax = payload.data.vehicles[0].attributions.find(
      (a) => a.key === "price.factors.roadTaxPct",
    );
    expect(roadTax?.sourceIds).toEqual(["src-1"]);
  });

  it("reports an unresolvable sourced fact rather than inventing a source", () => {
    const payload = run(build(two));

    const roadTax = payload.data.vehicles[0].attributions.find(
      (a) => a.key === "price.factors.roadTaxPct",
    );
    expect(roadTax?.sourceIds).toEqual([]);
    expect(payload.sources).toEqual([]);
    expect(
      payload.data.unattributed.some(
        (u) => u.variantId === "win" && u.key === "price.factors.roadTaxPct",
      ),
    ).toBe(true);
  });

  it("distinguishes a missing row id from a missing provenance row", () => {
    const payload = run(
      build(two, { references: { win: { onRoadFactorsId: "sorf-1" } } }),
    );

    const byKey = new Map(payload.data.unattributed.map((u) => [`${u.variantId}:${u.key}`, u]));
    expect(byKey.get("win:price.factors.roadTaxPct")?.reason).toBe("no_provenance_row");
    expect(byKey.get("win:price.exShowroomPaise")?.reason).toBe("no_provenance_row");
    expect(byKey.get("second:price.factors.roadTaxPct")?.reason).toBe("no_row_id");
  });

  it("says out loud, in the assumptions, that figures are untraced", () => {
    const payload = run(build(two));

    expect(payload.assumptions.join(" ")).toContain("not yet traced to a source");
  });

  it("labels a convention as ours and never lets it become a source", () => {
    const payload = run(
      build(two, {
        provenance: [provenanceFor("vehicle_variants", "win", "ex_showroom_paise")],
      }),
    );

    const escalation = payload.data.vehicles[0].attributions.find(
      (a) => a.key === "conventions.tco.priceEscalationPct",
    );
    expect(escalation?.attribution).toBe("modelling_convention");
    expect(escalation?.convention).toBe("TCO_CONVENTIONS.priceEscalationPct");
    expect(escalation?.sourceIds).toEqual([]);
    expect(payload.sources.flatMap((s) => s.fields.map((f) => f.field))).toEqual([
      "ex_showroom_paise",
    ]);
  });

  it("labels a biogenic figure as derived but carries the convention that placed it", () => {
    const biogenic = run(build(two)).data.vehicles[0].attributions.find(
      (a) => a.key === "co2.biogenicGramsCo2PerKm",
    );

    expect(biogenic?.attribution).toBe("derived");
    expect(biogenic?.convention).toBe("CO2_CONVENTIONS.countBiogenicCarbon");
    expect(biogenic?.note).toContain("never added to it");
  });

  it("never presents a combined figure that folds biogenic carbon into the total", () => {
    const blend: EthanolBlend = {
      ethanolSharePct: 20,
      baselineEthanolSharePct: 10,
      efficiencyPenaltyPct: 3.5,
      fossilGramsCo2ePerLitre: 1_200,
      biogenicGramsCo2PerLitre: 1_510,
      asOf: "2026-01-01",
    };
    const blended: Co2Breakdown = {
      ...co2("win", 120),
      blend,
      biogenicGramsCo2PerKm: 16.2,
    };
    const payload = run(build([{ id: "win", score: 82, co2: blended }]));
    const values = payload.data.vehicles[0].attributions.map((a) => a.value);

    expect(values).toContain(120);
    expect(values).toContain(16.2);
    expect(values).not.toContain(136.2);
  });

  it("labels the horizon and distance as the user's own input", () => {
    const payload = run(build(two));
    const horizon = payload.data.vehicles[0].attributions.find(
      (a) => a.key === "tco.ownershipYears",
    );

    expect(horizon?.attribution).toBe("user_input");
    expect(horizon?.value).toBe(5);
  });

  it("attributes a derived figure to the sources of the inputs it was computed from", () => {
    const payload = run(
      build(two, {
        references: { win: { emissionFactorId: "ef-1" } },
        provenance: [
          provenanceFor("emission_factors", "ef-1", "grams_co2e_per_unit", "src-2"),
        ],
      }),
    );

    const applied = payload.data.vehicles[0].attributions.find(
      (a) => a.key === "co2.appliedGramsCo2ePerUnit",
    );
    expect(applied?.attribution).toBe("derived");
    expect(applied?.sourceIds).toEqual(["src-2"]);
    expect(payload.sources.map((s) => s.sourceId)).toEqual(["src-2"]);
  });

  it("names what each derived number was derived from", () => {
    const onRoad = run(build(two)).data.vehicles[0].attributions.find(
      (a) => a.key === "price.onRoadPaise",
    );

    expect(onRoad?.derivedFrom).toContain("price.exShowroomPaise");
    expect(onRoad?.derivedFrom).toContain("price.roadTaxPaise");
  });

  it("lets the caller attribute a number the engine holds no mapping for", () => {
    const blend: EthanolBlend = {
      ethanolSharePct: 20,
      baselineEthanolSharePct: 10,
      efficiencyPenaltyPct: 3.5,
      fossilGramsCo2ePerLitre: 1_200,
      biogenicGramsCo2PerLitre: 1_510,
      asOf: "2026-01-01",
    };
    const blended: Co2Breakdown = { ...co2("win"), blend, biogenicGramsCo2PerKm: 16.2 };
    const input = build([{ id: "win", score: 82, co2: blended }], {
      references: {
        win: {
          extra: {
            "co2.blend.ethanolSharePct": {
              entityTable: "fuel_prices",
              entityId: "fp-1",
              field: "ethanol_share_pct",
            },
          },
        },
      },
      provenance: [provenanceFor("fuel_prices", "fp-1", "ethanol_share_pct", "src-2")],
    });
    const payload = run(input);

    const share = payload.data.vehicles[0].attributions.find(
      (a) => a.key === "co2.blend.ethanolSharePct",
    );
    expect(share?.sourceIds).toEqual(["src-2"]);
    expect(
      payload.data.unattributed.some((u) => u.key === "co2.blend.ethanolSharePct"),
    ).toBe(false);
  });

  it("lets the caller attribute a derived number too, not only a sourced one", () => {
    const payload = run(
      build(two, {
        references: {
          win: {
            extra: {
              "score.infrastructure.raw": {
                entityTable: "infra_density",
                entityId: "id-1",
                field: "percentile",
              },
            },
          },
        },
        provenance: [provenanceFor("infra_density", "id-1", "percentile", "src-2")],
        stage3: {
          scored: [
            {
              variantId: "win",
              name: "win (m-win)",
              totalScore: 82,
              subScores: [sub("infrastructure", 70, 64, 1)],
              unscored: [],
            },
            {
              variantId: "second",
              name: "second (m-second)",
              totalScore: 74,
              subScores: [sub("infrastructure", 40, 30, 1)],
              unscored: [],
            },
          ],
          weights: { infrastructure: 1 },
          weightBasis: [],
          assumptions: [],
        },
      }),
    );

    const infra = payload.data.vehicles[0].attributions.find(
      (a) => a.key === "score.infrastructure.raw",
    );
    expect(infra?.attribution).toBe("derived");
    expect(infra?.sourceIds).toEqual(["src-2"]);
    expect(payload.sources.map((s) => s.sourceId)).toEqual(["src-2"]);
  });

  it("attributes the specification figures the narrative quotes", () => {
    const input = build(two, {
      provenance: [provenanceFor("vehicle_variants", "win", "real_world_range_km")],
    });
    const payload = run({
      ...input,
      candidates: input.candidates.map((c) =>
        c.variant.variantId === "win"
          ? { ...c, variant: { ...c.variant, realWorldRangeKm: 380 } }
          : c,
      ),
    });

    const range = payload.data.vehicles[0].attributions.find(
      (a) => a.key === "variant.realWorldRangeKm",
    );
    expect(range?.value).toBe(380);
    expect(range?.attribution).toBe("sourced_fact");
    expect(range?.sourceIds).toEqual(["src-1"]);
    expect(range?.note).toContain("ARAI claim is never carried");

    const seats = payload.data.vehicles[0].attributions.find(
      (a) => a.key === "variant.seatingCapacity",
    );
    expect(seats?.value).toBe(5);
  });

  it("omits a specification figure the catalogue does not hold", () => {
    const keys = run(build(two)).data.vehicles[0].attributions.map((a) => a.key);

    /** `payloadKg` and `realWorldRangeKm` are null on this fixture: a hatchback
     * has no rated payload, and a missing range is not a range of zero. */
    expect(keys).not.toContain("variant.payloadKg");
    expect(keys).not.toContain("variant.realWorldRangeKm");
    expect(keys).toContain("variant.seatingCapacity");
  });

  it("cites only the sources a number in this answer actually used", () => {
    const payload = run(
      build(two, {
        provenance: [
          provenanceFor("vehicle_variants", "win", "ex_showroom_paise"),
          provenanceFor("vehicle_variants", "unrelated", "payload_kg", "src-2"),
        ],
      }),
    );

    expect(payload.sources.map((s) => s.sourceId)).toEqual(["src-1"]);
  });

  it("groups a source's fields together and carries its tier and confidence", () => {
    const payload = run(
      build(two, {
        references: { win: { onRoadFactorsId: "sorf-1" } },
        provenance: [
          provenanceFor("vehicle_variants", "win", "ex_showroom_paise"),
          provenanceFor("state_on_road_factors", "sorf-1", "road_tax_pct"),
        ],
      }),
    );

    expect(payload.sources).toHaveLength(1);
    expect(payload.sources[0].tier).toBe("government");
    expect(payload.sources[0].fields.map((f) => f.field)).toEqual([
      "road_tax_pct",
      "ex_showroom_paise",
    ]);
    expect(payload.sources[0].fields[0].confidence).toBe("high");
  });

  it("emits no attribution at all for a figure that does not exist", () => {
    const noCo2 = build([{ id: "win", score: 82, co2: null }]);
    const keys = run(noCo2).data.vehicles[0].attributions.map((a) => a.key);

    expect(keys.some((k) => k.startsWith("co2."))).toBe(false);
  });

  it("keeps money in whole paise, with no rupee or lakh field anywhere", () => {
    const payload = run(build(two));
    const paise = payload.data.vehicles[0].attributions.filter(
      (a) => a.unit === "paise",
    );

    expect(paise.length).toBeGreaterThan(0);
    for (const number of paise) expect(Number.isInteger(number.value)).toBe(true);
    expect(JSON.stringify(payload)).not.toContain("Rupee");
  });
});

/* -------------------------------------------------------------------------- */

describe("runStage5 commercial attribution", () => {
  const scenario = (
    label: CommercialScenario["label"],
    paybackMonth: number | null,
  ): CommercialScenario => ({
    label,
    revenuePaisePerKm: 3_500,
    driverCostPaisePerMonth: 2_000_000,
    grossRevenuePaise: lakhs(25),
    driverCostPaise: lakhs(12),
    operatingCostPaise: lakhs(18),
    operatingMarginPaise: lakhs(7),
    operatingMarginPctOfRevenue: 28,
    netProfitPaise: lakhs(4),
    netMarginPaisePerKm: 555.5,
    roiPct: 44.4,
    paybackMonth,
  });

  const economics = (
    sensitivitySource: CommercialEconomics["sensitivitySource"],
  ): CommercialEconomics => ({
    variantId: "win",
    ownershipYears: 5,
    totalKm: 72_000,
    capitalPaise: lakhs(9),
    kmPerOperatingDay: 60,
    base: scenario("base", 31),
    low: scenario("low", null),
    high: scenario("high", 22),
    operatingMarginStraddlesZero: false,
    netProfitStraddlesZero: true,
    sensitivity: { revenueSwingPct: 20, driverCostSwingPct: 12 },
    sensitivitySource,
    assumptions: [],
  });

  it("carries every scenario of the band, not just the base case", () => {
    const payload = run(
      build([{ id: "win", score: 82, commercial: economics("duty_cycle_default") }]),
    );
    const keys = payload.data.vehicles[0].attributions.map((a) => a.key);

    expect(keys).toContain("commercial.base.netMarginPaisePerKm");
    expect(keys).toContain("commercial.low.netProfitPaise");
    expect(keys).toContain("commercial.high.roiPct");
  });

  it("omits a payback month that never arrives rather than coercing it to zero", () => {
    const payload = run(
      build([{ id: "win", score: 82, commercial: economics("duty_cycle_default") }]),
    );
    const keys = payload.data.vehicles[0].attributions.map((a) => a.key);

    expect(keys).toContain("commercial.base.paybackMonth");
    expect(keys).not.toContain("commercial.low.paybackMonth");
    expect(payload.data.vehicles[0].commercial?.low.paybackMonth).toBeNull();
  });

  it("calls a defaulted sensitivity band our convention", () => {
    const payload = run(
      build([{ id: "win", score: 82, commercial: economics("duty_cycle_default") }]),
    );
    const swing = payload.data.vehicles[0].attributions.find(
      (a) => a.key === "commercial.sensitivity.revenueSwingPct",
    );

    expect(swing?.attribution).toBe("modelling_convention");
    expect(swing?.convention).toBe("DEFAULT_SENSITIVITY_BY_DUTY_CYCLE");
  });

  it("calls a supplied sensitivity band the operator's own input", () => {
    const payload = run(
      build([{ id: "win", score: 82, commercial: economics("supplied") }]),
    );
    const swing = payload.data.vehicles[0].attributions.find(
      (a) => a.key === "commercial.sensitivity.revenueSwingPct",
    );

    expect(swing?.attribution).toBe("user_input");
  });
});

/* -------------------------------------------------------------------------- */

describe("runStage5 contrast", () => {
  /** 90×0.5 + 40×0.5 = 65 against 30×0.5 + 88×0.5 = 59: the totals are the ones
   * stage 3 would actually have produced from these sub-scores, so the
   * decomposition has something real to sum back to. */
  const contrastSpecs: Spec[] = [
    {
      id: "win",
      score: 65,
      subScores: [sub("cost", 90, lakhs(11), 0.5), sub("reliability", 40, 200, 0.5)],
    },
    {
      id: "second",
      score: 59,
      subScores: [sub("cost", 30, lakhs(16), 0.5), sub("reliability", 88, 640, 0.5)],
    },
  ];

  it("decomposes the gap into per-dimension contributions that sum back to it", () => {
    const { contrast } = run(build(contrastSpecs)).data;
    const sum = contrast!.deltas.reduce((total, d) => total + d.contribution, 0);

    expect(contrast!.totalScoreGap).toBe(6);
    expect(sum).toBeCloseTo(contrast!.totalScoreGap, 1);
  });

  it("uses each side's own post-redistribution weight, not one shared weight", () => {
    const specs: Spec[] = [
      {
        id: "win",
        score: 80,
        subScores: [sub("cost", 80, lakhs(11), 1)],
      },
      {
        id: "second",
        score: 45,
        subScores: [sub("cost", 30, lakhs(16), 0.5), sub("reliability", 60, 640, 0.5)],
      },
    ];
    const { contrast } = run(build(specs)).data;
    const cost = contrast!.deltas.find((d) => d.dimension === "cost");

    expect(cost?.winnerWeight).toBe(1);
    expect(cost?.contenderWeight).toBe(0.5);
    expect(cost?.contribution).toBe(65);
    expect(
      contrast!.deltas.reduce((t, d) => t + d.contribution, 0),
    ).toBeCloseTo(contrast!.totalScoreGap, 1);
  });

  it("names the dimension that carried the win", () => {
    const { contrast } = run(build(contrastSpecs)).data;

    expect(contrast!.decidedBy[0]).toBe("cost");
  });

  it("says what the runner-up did better, rather than only what it lost on", () => {
    const { contrast } = run(build(contrastSpecs)).data;

    expect(contrast!.contenderWonOn).toContain("reliability");
    expect(contrast!.summary).toContain("better vehicle on reliability");
  });

  it("orders the deltas by how much they moved the result", () => {
    const { contrast } = run(build(contrastSpecs)).data;
    const magnitudes = contrast!.deltas.map((d) => Math.abs(d.contribution));

    expect([...magnitudes].sort((a, b) => b - a)).toEqual(magnitudes);
  });

  it("flags a dimension one side could not be scored on as a data gap", () => {
    const specs: Spec[] = [
      {
        id: "win",
        score: 90,
        subScores: [sub("cost", 90, lakhs(11), 1)],
      },
      {
        id: "second",
        score: 30,
        subScores: [
          sub("cost", 30, lakhs(16), 1),
          sub("reliability", null, null, 0, {
            note: "Not scored: we hold no service-centre count for this manufacturer.",
          }),
        ],
      },
    ];
    const { contrast } = run(build(specs)).data;
    const reliability = contrast!.deltas.find((d) => d.dimension === "reliability");

    expect(reliability?.dataGap).toBe(true);
    expect(reliability?.contribution).toBe(0);
    expect(contrast!.deltas.find((d) => d.dimension === "cost")?.dataGap).toBe(false);
  });

  it("carries the raw numbers behind both sides of every delta", () => {
    const { contrast } = run(build(contrastSpecs)).data;
    const cost = contrast!.deltas.find((d) => d.dimension === "cost");

    expect(cost?.winnerRaw).toBe(lakhs(11));
    expect(cost?.contenderRaw).toBe(lakhs(16));
    expect(cost?.unit).toBe("paise");
    expect(cost?.direction).toBe("lower_is_better");
    expect(cost?.range).toEqual({ min: 0, max: 100 });
  });

  it("reads as a finished sentence with the narrative disabled", () => {
    const { contrast } = run(build(contrastSpecs)).data;

    expect(contrast!.summary).toContain("leads");
    expect(contrast!.summary).toContain("6 points");
    expect(contrast!.summary.endsWith(".")).toBe(true);
  });

  /**
   * The hand-built fixtures above pick clean weights. This one runs the real
   * stage 3 and stage 4 first, so the decomposition is tested against the
   * weights stage 3 actually produces — two-place scores, four-place weights,
   * and a different post-redistribution weight on each candidate because their
   * data gaps differ. That divergence is the whole reason the contrast
   * multiplies score by weight per side instead of differencing scores.
   */
  it("sums back to the gap against stage 3's own rounded scores and weights", () => {
    const candidates: ScoringInput[] = [
      {
        variant: variant("cheap", "m1"),
        price,
        tco: tco("cheap", lakhs(11)),
        co2: co2("cheap", 132.4),
        commercial: null,
        /** No service-centre count, so reliability goes unscored here and its
         * weight is redistributed — giving the two candidates different
         * per-candidate weights on every other dimension. */
        serviceCentreCount: null,
        resaleLiquidityScore: 61,
      },
      {
        variant: variant("dear", "m2"),
        price,
        tco: tco("dear", lakhs(16)),
        co2: co2("dear", 171.9),
        commercial: null,
        serviceCentreCount: 640,
        resaleLiquidityScore: 78,
      },
    ];

    const stage3 = runStage3({ profile, candidates, infra: {} });
    const stage4 = runStage4({ candidates, scored: stage3.scored });
    if (!stage4.ok) throw new Error(stage4.reason);

    const payload = run({
      profile,
      asOf: "2026-08-23",
      engineVersion: "engine-2026.08.1",
      stage1: { candidates: [], exclusions: [], assumptions: [] },
      candidates,
      stage3,
      stage4,
    });

    const contrast = payload.data.contrast!;
    const winner = payload.data.vehicles[0];
    const runnerUp = payload.data.vehicles[1];

    const winnerWeights = new Map(winner.subScores.map((s) => [s.dimension, s.weight]));
    const runnerUpWeights = new Map(
      runnerUp.subScores.map((s) => [s.dimension, s.weight]),
    );
    expect(winnerWeights.get("cost")).not.toBe(runnerUpWeights.get("cost"));

    const sum = contrast.deltas.reduce((total, d) => total + d.contribution, 0);
    expect(sum).toBeCloseTo(contrast.totalScoreGap, 1);
    expect(contrast.decidedBy.length).toBeGreaterThan(0);
  });

  /**
   * Regression: contribution alone is not evidence that a dimension separated
   * the two vehicles. `cheap` carries no service-centre count, so reliability
   * is a pure data gap; and stage 3 marks usage and infrastructure degenerate,
   * scoring both candidates a flat NEUTRAL 50. Those still carry a non-zero
   * contribution, because the unscored reliability weight is redistributed
   * unevenly between the two. Reporting either as a win puts a claim in the
   * payload the numbers do not support — and the payload is the only thing the
   * narrator may speak from.
   */
  it("credits neither side for a data gap or for a dimension they tied on", () => {
    const candidates: ScoringInput[] = [
      {
        variant: variant("cheap", "m1"),
        price,
        tco: tco("cheap", lakhs(11)),
        co2: co2("cheap", 132.4),
        commercial: null,
        serviceCentreCount: null,
        resaleLiquidityScore: 61,
      },
      {
        variant: variant("dear", "m2"),
        price,
        tco: tco("dear", lakhs(16)),
        co2: co2("dear", 171.9),
        commercial: null,
        serviceCentreCount: 640,
        resaleLiquidityScore: 78,
      },
    ];

    const stage3 = runStage3({ profile, candidates, infra: {} });
    const stage4 = runStage4({ candidates, scored: stage3.scored });
    if (!stage4.ok) throw new Error(stage4.reason);

    const contrast = run({
      profile,
      asOf: "2026-08-23",
      engineVersion: "engine-2026.08.1",
      stage1: { candidates: [], exclusions: [], assumptions: [] },
      candidates,
      stage3,
      stage4,
    }).data.contrast!;

    const reliability = contrast.deltas.find((d) => d.dimension === "reliability");
    expect(reliability?.dataGap).toBe(true);
    expect(contrast.contenderWonOn).not.toContain("reliability");
    expect(contrast.summary).not.toMatch(/better vehicle on[^.]*reliability/);

    // Every dimension named on either side must show a real score difference.
    for (const dimension of [...contrast.decidedBy, ...contrast.contenderWonOn]) {
      const delta = contrast.deltas.find((d) => d.dimension === dimension)!;
      expect(delta.dataGap).toBe(false);
      expect(delta.winnerScore).not.toBe(delta.contenderScore);
    }
  });

  it("has no contrast to draw for a single-vehicle result", () => {
    expect(run(build([{ id: "win", score: 82 }])).data.contrast).toBeNull();
  });

  it("handles two vehicles that tied", () => {
    const { contrast } = run(
      build([
        { id: "alpha", score: 70 },
        { id: "beta", score: 70 },
      ]),
    ).data;

    expect(contrast!.totalScoreGap).toBe(0);
    expect(contrast!.summary).toContain("score the same overall");
  });
});

/* -------------------------------------------------------------------------- */

describe("runStage5 exclusions, omissions and assumptions", () => {
  const exclusion = (variantId: string): Exclusion => ({
    variantId,
    name: variantId,
    stage: "hard_filter",
    code: "above_budget",
    reason: `${variantId} costs ₹14.20L on the road, above your ₹12.00L budget.`,
  });

  const omission = (variantId: string): Omission => ({
    variantId,
    name: variantId,
    code: "model_cap",
    reason: "Two variants of this model are already in your results.",
  });

  it("carries every stage-1 exclusion through with its sentence intact", () => {
    const input = build(two);
    const payload = run({
      ...input,
      stage1: {
        ...input.stage1,
        exclusions: [exclusion("x1"), exclusion("x2")],
      },
    });

    expect(payload.data.exclusions).toHaveLength(2);
    expect(payload.data.exclusions[0].reason).toBe(exclusion("x1").reason);
    expect(payload.data.exclusionCounts.above_budget).toBe(2);
    expect(payload.data.run.excludedCount).toBe(2);
  });

  it("carries every stage-4 omission through with its sentence intact", () => {
    const input = build(two);
    const payload = run({
      ...input,
      stage4: { ...input.stage4, omitted: [omission("o1")] },
    });

    expect(payload.data.omissions[0].reason).toBe(omission("o1").reason);
    expect(payload.data.run.omittedCount).toBe(1);
  });

  it("prefixes a vehicle's own assumptions so two vehicles' lines do not merge", () => {
    const payload = run(build(two));

    expect(payload.assumptions).toContain(
      "win (m-win): Service pricing for win is taken from the segment curve.",
    );
    expect(payload.assumptions).toContain(
      "second (m-second): Service pricing for second is taken from the segment curve.",
    );
  });

  it("keeps each vehicle's unprefixed copy on the vehicle itself", () => {
    const payload = run(build(two));

    expect(payload.data.vehicles[0].assumptions).toContain(
      "Service pricing for win is taken from the segment curve.",
    );
  });

  it("dedupes identical lines without collapsing distinct ones", () => {
    const input = build(two);
    const payload = run({
      ...input,
      stage1: { ...input.stage1, assumptions: ["Shared line.", "Shared line."] },
      stage4: { ...input.stage4, assumptions: ["Shared line."] },
    });

    expect(payload.assumptions.filter((a) => a === "Shared line.")).toHaveLength(1);
  });

  it("orders assumptions from the filters through to the ranking", () => {
    const input = build(two);
    const payload = run({
      ...input,
      stage1: { ...input.stage1, assumptions: ["From stage one."] },
      stage3: { ...input.stage3, assumptions: ["From stage three."] },
      stage4: { ...input.stage4, assumptions: ["From stage four."] },
    });

    const positions = ["From stage one.", "From stage three.", "From stage four."].map(
      (line) => payload.assumptions.indexOf(line),
    );
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(positions[0]).toBe(0);
  });

  it("does not fold an unranked vehicle's assumptions into the global list", () => {
    const input = build(two);
    const payload = run({
      ...input,
      stage4: { ...input.stage4, ranked: input.stage4.ranked.slice(0, 1) },
    });

    expect(payload.assumptions.join(" ")).not.toContain("Service pricing for second");
  });
});

/* -------------------------------------------------------------------------- */

describe("runStage5 conventions", () => {
  it("states every convention the run applied, by reference to the exported constants", () => {
    const { conventions } = run(build(two)).data;

    expect(conventions.co2.countBiogenicCarbon).toBe(false);
    expect(conventions.tco.priceEscalationPct).toBe(0);
    expect(conventions.commercial.roiDenominator).toBe("acquisition");
    expect(conventions.gates.evRangeUtilisation).toBe(0.8);
    expect(conventions.fit.seatSurplusPenalty).toBe(8);
    expect(conventions.neutralScore).toBe(50);
    expect(conventions.diversification.maxVariantsPerModel).toBe(2);
    expect(conventions.baseWeights.passenger.cost).toBeGreaterThan(0);
  });

  it("never lets a convention appear as a cited source", () => {
    const payload = run(
      build(two, {
        provenance: [provenanceFor("vehicle_variants", "win", "ex_showroom_paise")],
      }),
    );

    const fields = payload.sources.flatMap((s) => s.fields.map((f) => f.field));
    expect(fields).not.toContain("countBiogenicCarbon");
    expect(fields).not.toContain("priceEscalationPct");
  });
});

/* -------------------------------------------------------------------------- */

describe("runStage5 determinism and completeness", () => {
  it("produces a byte-identical payload from the same input twice", () => {
    const input = build(two, {
      references: { win: { onRoadFactorsId: "sorf-1" } },
      provenance: [provenanceFor("state_on_road_factors", "sorf-1", "road_tax_pct")],
    });

    expect(JSON.stringify(run(input))).toBe(JSON.stringify(run(input)));
  });

  it("reads no clock, no locale and no randomness", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("./stage5.ts", import.meta.url), "utf8"),
    );

    expect(source).not.toMatch(/new Date|Date\.now|Math\.random|toLocaleString/);
  });

  it("carries every figure the card renders, which is what the downstream guard checks", () => {
    const payload = run(build(two));
    const rendered = JSON.stringify(payload);

    for (const figure of [
      payload.data.vehicles[0].totalScore,
      payload.data.vehicles[0].price.onRoadPaise,
      payload.data.vehicles[0].tco.totalPaise,
      payload.data.vehicles[0].tco.costPaisePerKm,
      payload.data.vehicles[0].co2!.gramsCo2ePerKm,
      payload.data.contrast!.totalScoreGap,
    ]) {
      expect(rendered).toContain(String(figure));
    }
  });

  it("carries a raw number, a weight and a range for every sub-score", () => {
    const payload = run(build(two));
    const keys = new Set(payload.data.vehicles[0].attributions.map((a) => a.key));

    for (const dimension of ["cost", "reliability", "resale"]) {
      expect(keys.has(`score.${dimension}.raw`)).toBe(true);
      expect(keys.has(`score.${dimension}.score`)).toBe(true);
      expect(keys.has(`score.${dimension}.weight`)).toBe(true);
      expect(keys.has(`score.${dimension}.range.min`)).toBe(true);
    }
    expect(keys.has("totalScore")).toBe(true);
  });

  it("gives every attributed number a unique key within its vehicle", () => {
    const payload = run(build(two));
    const keys = payload.data.vehicles[0].attributions.map((a) => a.key);

    expect(new Set(keys).size).toBe(keys.length);
  });

  it("labels every attributed number with a renderable phrase and a unit", () => {
    for (const number of run(build(two)).data.vehicles[0].attributions) {
      expect(number.label.length).toBeGreaterThan(0);
      expect(number.unit.length).toBeGreaterThan(0);
      expect(Number.isFinite(number.value)).toBe(true);
    }
  });
});
