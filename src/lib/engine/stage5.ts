import type { CandidateVariant, Exclusion, ExclusionCode } from "./candidate";
import { CO2_CONVENTIONS, type Co2Breakdown } from "./co2";
import {
  COMMERCIAL_CONVENTIONS,
  DEFAULT_SENSITIVITY_BY_DUTY_CYCLE,
  type CommercialEconomics,
} from "./commercial";
import type { FuelType } from "./enums";
import type { OnRoadPrice } from "./on-road";
import type { RecommendationProfile } from "./profile";
import { GATE_THRESHOLDS, type Stage1Result } from "./stage1";
import {
  BASE_WEIGHTS,
  FIT_PARAMETERS,
  NEUTRAL_SCORE,
  SCORE_DIMENSIONS,
  SCORING_CONVENTIONS,
  type ScoreDimension,
  type ScoreDirection,
  type ScoreRange,
  type ScoredCandidate,
  type ScoringInput,
  type Stage3Result,
  type SubScore,
} from "./stage3";
import {
  DEFAULT_RESULT_LIMIT,
  MAX_VARIANTS_PER_MODEL,
  MIN_DISTINCT_FUELS,
  type Omission,
  type SelectionReason,
  type Stage4Result,
} from "./stage4";
import { breakEvenMonth, TCO_CONVENTIONS, type TcoBreakdown } from "./tco";

/**
 * Stage 5 — the explainability payload (FR-A9, FR-A10, FR-A11, FR-A12).
 *
 * This is the only thing the narrative model is ever shown, and the only thing
 * it is allowed to speak from: **a number in the model's output that is absent
 * from this payload fails the response and falls back to a deterministic
 * template**. That guard is what makes the product defensible, and it only
 * works if the payload is complete — so every figure the narration could
 * plausibly reach for is carried here, in the form the card renders it.
 *
 * Which means this stage does **assembly, not arithmetic**. Stages 1–4 already
 * produced every input, intermediate and weight; recomputing any of them here
 * would put a second copy of a number in the codebase that can drift out of
 * step with the first, and would re-round figures the earlier stages
 * deliberately left unrounded (`costPaisePerKm`, `gramsCo2ePerKm` — both rates).
 * The single call into an earlier module is the exported `breakEvenMonth`,
 * because the runner-up contrast needs a figure nobody had a reason to compute
 * before now.
 *
 * The other half of the job is **attribution**: labelling every number as a
 * sourced fact (a Postgres value with a `fact_provenance` row → `sources`) or a
 * modelling convention (an exported `*_CONVENTIONS` / `*_PARAMETERS` value that
 * is ours → `assumptions`). Conflating the two is the failure mode this whole
 * document guards against, so the label is carried on the number itself rather
 * than inferred downstream.
 *
 * No database access, no clock, no LLM. `asOf` and `engineVersion` are
 * parameters, so a stored run replays to a byte-identical payload (FR-A12).
 */

/* -------------------------------------------------------------------------- */
/* Provenance, engine-side                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Engine-side copies of `confidence_level` and `source_tier`.
 *
 * They live here rather than in `enums.ts` only because this change owns two
 * files; they belong beside the other mirrored tuples and should move there.
 * `stage5.test.ts` asserts both against the Drizzle enums, so drift fails the
 * build wherever they sit. A test may import both sides; the engine may not.
 */
export const CONFIDENCE_LEVELS = ["high", "medium", "low"] as const;
export type ProvenanceConfidence = (typeof CONFIDENCE_LEVELS)[number];

export const SOURCE_TIERS = [
  "oem",
  "government",
  "industry_body",
  "licensed_aggregator",
  "editorial",
  "community",
  /** Ours, not anyone's: a figure the ingestion pipeline derived rather than
   * read. It is still a `fact_provenance` row, so it still cites — but a
   * reader should be able to see that nobody outside this codebase said it. */
  "internal_estimate",
] as const;
export type SourceTier = (typeof SOURCE_TIERS)[number];

/**
 * One `fact_provenance` row joined to its `sources` row, as plain data.
 *
 * The engine cannot reach either table, so provenance arrives as an input. It
 * is optional: `src/lib/data/` does not exist yet, and a payload that reports
 * honestly which numbers are unattributed is worth more than one that waits
 * for the query layer.
 */
export interface ProvenanceRecord {
  entityTable: string;
  entityId: string;
  field: string;
  sourceId: string;
  sourceSlug: string;
  sourceName: string;
  tier: SourceTier;
  sourceUrl?: string | null;
  excerpt?: string | null;
  confidence: ProvenanceConfidence;
  /** ISO `YYYY-MM-DD`, string-compared like every other date in the engine. */
  verifiedAt: string;
}

/** The `(entityTable, entityId, field)` triple a sourced number resolves on. */
export interface FactRef {
  entityTable: string;
  entityId: string;
  field: string;
}

/**
 * Row ids for the reference tables whose values reached one vehicle's numbers.
 *
 * `OnRoadFactors`, `EmissionFactor` and the curve types carry no id in the
 * engine's plain-data projections — the engine has no use for one — so the
 * caller supplies them per vehicle. A missing id is not an error: the numbers
 * it would have attributed are reported on `data.unattributed` instead. Never
 * fabricate an id, and never synthesise a source.
 */
export interface VehicleReferences {
  /** `state_on_road_factors.id` — the row behind the price breakdown. */
  onRoadFactorsId?: string;
  /** `emission_factors.id` — the row behind the g/km figure. */
  emissionFactorId?: string;
  /** `manufacturers.id` — the row behind the service-centre count. */
  manufacturerId?: string;
  /** `resale_curves.id` — the row behind the liquidity score. */
  resaleCurveId?: string;
  /** `e20_compatibility.id` — the row behind an ethanol blend's mileage delta. */
  e20CompatibilityId?: string;
  /**
   * Explicit triples for numbers the engine holds no fixed mapping for — the
   * ethanol blend's per-litre factors, for instance. Keyed by the
   * `AttributedNumber.key` they attribute, and they win over the built-in
   * mapping when both apply.
   */
  extra?: Readonly<Record<string, FactRef>>;
}

/** One source, with every field of this answer it stands behind. */
export interface CitedSource {
  sourceId: string;
  slug: string;
  name: string;
  tier: SourceTier;
  url: string | null;
  fields: {
    entityTable: string;
    entityId: string;
    field: string;
    confidence: ProvenanceConfidence;
    verifiedAt: string;
    excerpt: string | null;
  }[];
}

/* -------------------------------------------------------------------------- */
/* Attribution                                                                 */
/* -------------------------------------------------------------------------- */

export type Attribution =
  /** A Postgres value with a `fact_provenance` row behind it → `sources`. */
  | "sourced_fact"
  /** An exported `*_CONVENTIONS` / `*_PARAMETERS` value of ours → `assumptions`. */
  | "modelling_convention"
  /** Straight off the validated profile. */
  | "user_input"
  /** Arithmetic an earlier stage did over the above. */
  | "derived";

export interface AttributedNumber {
  /** Stable dotted path, e.g. `price.onRoadPaise`. Unique within a vehicle. */
  key: string;
  /** Finished noun phrase, renderable as-is. */
  label: string;
  value: number;
  /** `paise`, `paise/km`, `pct`, `g CO2e/km`, `months`, `score`, … */
  unit: string;
  attribution: Attribution;
  /**
   * For a sourced fact, the sources that stand behind it. For a derived
   * figure, the sources behind the inputs it was computed from, where those
   * inputs are themselves sourced — a g/km number whose emission factor has a
   * source is attributable even though the division is ours. Empty means
   * unattributed, and for a sourced fact that also lands on
   * `data.unattributed`.
   */
  sourceIds: string[];
  /** The exported constant that decided this, for a modelling convention. */
  convention?: string;
  /** Other keys in the same vehicle's list, for a derived figure. */
  derivedFrom?: string[];
  /** Present where the figure is a composite or needs a caveat stated. */
  note?: string;
}

/** A number we could not attribute, named rather than quietly left bare. */
export interface UnattributedNumber {
  variantId: string;
  key: string;
  entityTable: string | null;
  field: string | null;
  reason: "no_row_id" | "no_provenance_row";
}

/* -------------------------------------------------------------------------- */
/* Payload                                                                     */
/* -------------------------------------------------------------------------- */

export interface ScoreDelta {
  dimension: ScoreDimension;
  winnerScore: number | null;
  contenderScore: number | null;
  /** Per-candidate weights, **after** redistribution. They differ between two
   * candidates whose data gaps differ, which is why the decomposition is
   * `score × weight` per side rather than a shared weight over a score gap. */
  winnerWeight: number;
  contenderWeight: number;
  winnerRaw: number | null;
  contenderRaw: number | null;
  unit: string;
  direction: ScoreDirection;
  /** The winner's range, or the contender's where the winner was unscored. */
  range: ScoreRange | null;
  /** `round2(winnerScore × winnerWeight − contenderScore × contenderWeight)`.
   * Positive means the dimension moved the result toward the winner. */
  contribution: number;
  /** At least one side carried no value here — a data gap, not a defeat. */
  dataGap: boolean;
}

export interface Contrast {
  winnerVariantId: string;
  winnerName: string;
  contenderVariantId: string;
  contenderName: string;
  /** `round2(winner.totalScore − contender.totalScore)`. */
  totalScoreGap: number;
  /** Every dimension, largest absolute contribution first. */
  deltas: ScoreDelta[];
  /** The dimensions that carried the win, at most three. */
  decidedBy: ScoreDimension[];
  /** What the runner-up actually did better. Saying so is the point of a
   * contrast: a comparison that only lists the winner's strengths is an
   * advert. */
  contenderWonOn: ScoreDimension[];
  /** A finished sentence. This is the FR-A10 fallback, so it must read
   * correctly with the narrative disabled. */
  summary: string;
}

export interface ExplainedVehicle {
  rank: number;
  variantId: string;
  modelId: string;
  name: string;
  fuelType: FuelType;
  totalScore: number;
  selectedBy: SelectionReason;
  bestInFuel: boolean;
  variant: CandidateVariant;
  /** Carries `factors` — the `state_on_road_factors` row that priced it. */
  price: OnRoadPrice;
  /** Carries `yearly` — the year-by-year series. */
  tco: TcoBreakdown;
  /** Carries `factor`, `blend`, `effectiveEfficiency` and
   * `appliedGramsCo2ePerUnit`, so the division can be re-done by hand. */
  co2: Co2Breakdown | null;
  commercial: CommercialEconomics | null;
  subScores: SubScore[];
  unscored: ScoredCandidate["unscored"];
  attributions: AttributedNumber[];
  /** This vehicle's own stage-2 assumptions, unprefixed. */
  assumptions: string[];
  /**
   * Months until this vehicle's cumulative spend falls below the top pick's.
   * `null` means it never catches up inside the horizon — a real answer.
   * Absent on rank 1, which is its own baseline.
   */
  breakEvenMonthVsTopPick?: number | null;
}

/** The conventions applied to this run, by reference to the exported objects
 * rather than as copies — §0 of `docs/RECOMMENDATION-ENGINE.md` is why they are
 * exported as data at all. */
export interface AppliedConventions {
  tco: typeof TCO_CONVENTIONS;
  co2: typeof CO2_CONVENTIONS;
  commercial: typeof COMMERCIAL_CONVENTIONS;
  commercialSensitivityDefaults: typeof DEFAULT_SENSITIVITY_BY_DUTY_CYCLE;
  scoring: typeof SCORING_CONVENTIONS;
  gates: typeof GATE_THRESHOLDS;
  fit: typeof FIT_PARAMETERS;
  baseWeights: typeof BASE_WEIGHTS;
  neutralScore: typeof NEUTRAL_SCORE;
  diversification: {
    maxVariantsPerModel: typeof MAX_VARIANTS_PER_MODEL;
    minDistinctFuels: typeof MIN_DISTINCT_FUELS;
    defaultResultLimit: typeof DEFAULT_RESULT_LIMIT;
  };
}

export interface PayloadData {
  run: {
    asOf: string;
    engineVersion: string;
    /** Verbatim, so the run is reproducible (FR-A12). */
    profile: RecommendationProfile;
    /** Survivors of stage 1 that reached scoring. */
    candidateCount: number;
    rankedCount: number;
    excludedCount: number;
    omittedCount: number;
  };
  /** Persona weights, **before** per-candidate redistribution. */
  weights: Partial<Record<ScoreDimension, number>>;
  weightBasis: string[];
  /** Rank order. */
  vehicles: ExplainedVehicle[];
  /** Rank 1 against rank 2. `null` when fewer than two vehicles are shown. */
  contrast: Contrast | null;
  exclusions: Exclusion[];
  exclusionCounts: Partial<Record<ExclusionCode, number>>;
  omissions: Omission[];
  conventions: AppliedConventions;
  /** Numbers no `fact_provenance` row could be found for. Reported rather than
   * papered over: FR-A11 says a number never reaches a user unattributed, and
   * the honest form of that during build-out is to name the gaps. */
  unattributed: UnattributedNumber[];
}

/** `{ data, assumptions, sources }` — the shape every API response carries. */
export interface ExplainabilityPayload {
  data: PayloadData;
  assumptions: string[];
  sources: CitedSource[];
}

export interface Stage5Input {
  profile: RecommendationProfile;
  /** ISO `YYYY-MM-DD`. Never a clock (FR-A12). */
  asOf: string;
  /** Stored on `recommendation_runs.engineVersion`; the narrative cache keys
   * on it, because anything that changes a ranking is a version bump. */
  engineVersion: string;
  stage1: Stage1Result;
  /** The same array stages 3 and 4 were given. */
  candidates: readonly ScoringInput[];
  stage3: Stage3Result;
  /**
   * Narrowed by the caller. Typing this as the whole union would force an `ok`
   * check here that duplicates the one the caller already had to make.
   */
  stage4: Extract<Stage4Result, { ok: true }>;
  provenance?: readonly ProvenanceRecord[];
  /** Keyed by `variantId`. */
  references?: Readonly<Record<string, VehicleReferences>>;
}

export type Stage5Result =
  | { ok: true; payload: ExplainabilityPayload }
  | { ok: false; code: "candidate_missing" | "score_missing"; reason: string };

/* -------------------------------------------------------------------------- */
/* Attribution machinery                                                       */
/* -------------------------------------------------------------------------- */

/** Matches stage 3's rounding, so the two figures this stage creates are
 * rounded the way every other presentation figure in the payload is. */
const round2 = (n: number) => Math.round(n * 100) / 100;

const refKey = (entityTable: string, entityId: string, field: string) =>
  `${entityTable} ${entityId} ${field}`;

const indexProvenance = (
  records: readonly ProvenanceRecord[],
): Map<string, ProvenanceRecord[]> => {
  const index = new Map<string, ProvenanceRecord[]>();
  for (const record of records) {
    const key = refKey(record.entityTable, record.entityId, record.field);
    const bucket = index.get(key);
    if (bucket === undefined) index.set(key, [record]);
    else bucket.push(record);
  }
  return index;
};

interface Ctx {
  variantId: string;
  refs: VehicleReferences;
  index: Map<string, ProvenanceRecord[]>;
  out: AttributedNumber[];
  cited: ProvenanceRecord[];
  unattributed: UnattributedNumber[];
}

/** `null`, `undefined` and non-finite values are skipped rather than emitted as
 * a zero — a missing number and a number that happens to be zero are different
 * claims, and the payload must not let them read the same. */
const usable = (value: number | null | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** Resolve one or more `(table, id, field)` triples to source ids, recording
 * every provenance row that was actually cited. Returns `null` when nothing
 * resolved, which is different from resolving to an empty set. */
function resolve(
  ctx: Ctx,
  key: string,
  entityTable: string | null,
  entityId: string | undefined,
  fields: readonly string[],
): { sourceIds: string[]; reason: UnattributedNumber["reason"] } | null {
  const override = ctx.refs.extra?.[key];
  const table = override?.entityTable ?? entityTable;
  const id = override?.entityId ?? entityId;
  const wanted = override === undefined ? fields : [override.field];

  if (table === null || id === undefined) {
    return { sourceIds: [], reason: "no_row_id" };
  }

  const found: string[] = [];
  for (const field of wanted) {
    for (const record of ctx.index.get(refKey(table, id, field)) ?? []) {
      ctx.cited.push(record);
      if (!found.includes(record.sourceId)) found.push(record.sourceId);
    }
  }

  if (found.length === 0) return { sourceIds: [], reason: "no_provenance_row" };
  return { sourceIds: found, reason: "no_provenance_row" };
}

/** A Postgres value. Its provenance is looked up, never guessed. */
function sourced(
  ctx: Ctx,
  key: string,
  label: string,
  value: number | null | undefined,
  unit: string,
  entityTable: string | null,
  entityId: string | undefined,
  fields: readonly string[],
  note?: string,
): void {
  if (!usable(value)) return;
  const resolved = resolve(ctx, key, entityTable, entityId, fields);
  const sourceIds = resolved?.sourceIds ?? [];
  if (sourceIds.length === 0) {
    ctx.unattributed.push({
      variantId: ctx.variantId,
      key,
      entityTable: ctx.refs.extra?.[key]?.entityTable ?? entityTable,
      field: ctx.refs.extra?.[key]?.field ?? fields[0] ?? null,
      reason: resolved?.reason ?? "no_provenance_row",
    });
  }
  ctx.out.push({
    key,
    label,
    value,
    unit,
    attribution: "sourced_fact",
    sourceIds,
    ...(note === undefined ? {} : { note }),
  });
}

/** Arithmetic an earlier stage did. `from` names the keys it was done over;
 * `via` names the sourced rows behind those inputs, where they exist. */
function derived(
  ctx: Ctx,
  key: string,
  label: string,
  value: number | null | undefined,
  unit: string,
  from: readonly string[],
  options?: {
    via?: { entityTable: string; entityId: string | undefined; fields: readonly string[] };
    convention?: string;
    note?: string;
  },
): void {
  if (!usable(value)) return;
  const via = options?.via;
  /**
   * A caller-supplied `extra` triple attributes a derived figure too — the
   * infrastructure index, for instance, whose inputs are `infra_density` rows
   * the engine holds no id for. `resolve` prefers the override, so the `via`
   * placeholder below is only ever a fallback; without this branch the escape
   * hatch would silently do nothing for derived numbers, which is worse than
   * not offering one.
   */
  const override = ctx.refs.extra?.[key];
  const sourceIds =
    via === undefined && override === undefined
      ? []
      : (resolve(
          ctx,
          key,
          via?.entityTable ?? null,
          via?.entityId,
          via?.fields ?? [],
        )?.sourceIds ?? []);
  ctx.out.push({
    key,
    label,
    value,
    unit,
    attribution: "derived",
    sourceIds,
    derivedFrom: [...from],
    ...(options?.convention === undefined ? {} : { convention: options.convention }),
    ...(options?.note === undefined ? {} : { note: options.note }),
  });
}

/** A decision of ours. Never a `CitedSource`; always an assumption. */
function convention(
  ctx: Ctx,
  key: string,
  label: string,
  value: number | null | undefined,
  unit: string,
  name: string,
  note?: string,
): void {
  if (!usable(value)) return;
  ctx.out.push({
    key,
    label,
    value,
    unit,
    attribution: "modelling_convention",
    sourceIds: [],
    convention: name,
    ...(note === undefined ? {} : { note }),
  });
}

/** Straight off the profile. */
function userInput(
  ctx: Ctx,
  key: string,
  label: string,
  value: number | null | undefined,
  unit: string,
  note?: string,
): void {
  if (!usable(value)) return;
  ctx.out.push({
    key,
    label,
    value,
    unit,
    attribution: "user_input",
    sourceIds: [],
    ...(note === undefined ? {} : { note }),
  });
}

/* -------------------------------------------------------------------------- */
/* Per-vehicle attribution                                                     */
/* -------------------------------------------------------------------------- */

const VARIANTS = "vehicle_variants";
const ON_ROAD = "state_on_road_factors";
const EMISSIONS = "emission_factors";

/**
 * The specification figures the narration reaches for when it says a vehicle
 * "seats five" or "does 380 km on a charge". They are in the payload anyway,
 * on `vehicle.variant` — attributing them is what stops a catalogue number
 * being repeated to a user with nothing standing behind it.
 */
function attributeVariant(ctx: Ctx, variant: CandidateVariant): void {
  sourced(
    ctx,
    "variant.seatingCapacity",
    "Seats",
    variant.seatingCapacity,
    "seats",
    VARIANTS,
    ctx.variantId,
    ["seating_capacity"],
  );
  sourced(
    ctx,
    "variant.payloadKg",
    "Rated payload",
    variant.payloadKg,
    "kg",
    VARIANTS,
    ctx.variantId,
    ["payload_kg"],
  );
  sourced(
    ctx,
    "variant.realWorldRangeKm",
    "Real-world range on a full tank or charge",
    variant.realWorldRangeKm,
    "km",
    VARIANTS,
    ctx.variantId,
    ["real_world_range_km"],
    "What it actually does in Indian traffic with the AC on. The ARAI claim is never carried and never calculated from.",
  );
}

function attributePrice(ctx: Ctx, price: OnRoadPrice): void {
  const onRoadId = ctx.refs.onRoadFactorsId;

  sourced(
    ctx,
    "price.exShowroomPaise",
    "Ex-showroom price",
    price.exShowroomPaise,
    "paise",
    VARIANTS,
    ctx.variantId,
    ["ex_showroom_paise"],
  );

  sourced(
    ctx,
    "price.factors.roadTaxPct",
    `Road tax rate in ${price.factors.stateCode}`,
    price.factors.roadTaxPct,
    "pct",
    ON_ROAD,
    onRoadId,
    ["road_tax_pct"],
  );
  derived(ctx, "price.roadTaxPaise", "Road tax", price.roadTaxPaise, "paise", [
    "price.exShowroomPaise",
    "price.factors.roadTaxPct",
  ]);

  sourced(
    ctx,
    "price.registrationFeePaise",
    "Registration fee",
    price.registrationFeePaise,
    "paise",
    ON_ROAD,
    onRoadId,
    ["registration_fee_paise"],
  );

  sourced(
    ctx,
    "price.factors.insurancePct",
    "First-year insurance rate",
    price.factors.insurancePct,
    "pct",
    ON_ROAD,
    onRoadId,
    ["insurance_pct"],
  );
  derived(
    ctx,
    "price.insurancePaise",
    "First-year insurance",
    price.insurancePaise,
    "paise",
    ["price.exShowroomPaise", "price.factors.insurancePct"],
  );

  sourced(
    ctx,
    "price.otherLevyPaise",
    "Other state levies, net of any subsidy",
    price.otherLevyPaise,
    "paise",
    ON_ROAD,
    onRoadId,
    ["other_levy_paise"],
    "Negative for a rebate — an EV subsidy lands here.",
  );

  derived(ctx, "price.onRoadPaise", "On-road price", price.onRoadPaise, "paise", [
    "price.exShowroomPaise",
    "price.roadTaxPaise",
    "price.registrationFeePaise",
    "price.insurancePaise",
    "price.otherLevyPaise",
  ]);
}

function attributeTco(ctx: Ctx, tco: TcoBreakdown): void {
  userInput(ctx, "tco.ownershipYears", "Ownership horizon", tco.ownershipYears, "years");
  userInput(
    ctx,
    "tco.totalKm",
    "Distance over the horizon",
    tco.totalKm,
    "km",
    "From the monthly distance you stated.",
  );

  derived(
    ctx,
    "tco.acquisitionPaise",
    "Acquisition cost",
    tco.acquisitionPaise,
    "paise",
    ["price.onRoadPaise"],
    { note: "On-road price plus any loan processing fee." },
  );

  const legs: [key: string, label: string, value: number][] = [
    ["tco.energyPaise", "Fuel or electricity over the horizon", tco.energyPaise],
    ["tco.maintenancePaise", "Maintenance over the horizon", tco.maintenancePaise],
    [
      "tco.insuranceRenewalPaise",
      "Insurance renewals over the horizon",
      tco.insuranceRenewalPaise,
    ],
    [
      "tco.financingInterestPaise",
      "Loan interest inside the horizon",
      tco.financingInterestPaise,
    ],
    [
      "tco.batteryReplacementPaise",
      "Expected owner-borne battery replacement",
      tco.batteryReplacementPaise,
    ],
    ["tco.resaleNominalPaise", "Face-value residual at the end of the horizon", tco.resaleNominalPaise],
    ["tco.resaleCreditPaise", "Discounted resale credit", tco.resaleCreditPaise],
  ];
  for (const [key, label, value] of legs) {
    derived(ctx, key, label, value, "paise", ["tco.totalKm", "tco.ownershipYears"]);
  }

  derived(
    ctx,
    "tco.totalPaise",
    "Total cost of ownership, net of resale",
    tco.totalPaise,
    "paise",
    legs.map(([key]) => key).concat("tco.acquisitionPaise"),
  );
  derived(
    ctx,
    "tco.costPaisePerKm",
    "Running cost per kilometre",
    tco.costPaisePerKm,
    "paise/km",
    ["tco.totalPaise", "tco.totalKm"],
    { note: "A rate, so it is carried unrounded." },
  );

  convention(
    ctx,
    "conventions.tco.priceEscalationPct",
    "Assumed annual escalation in energy and service prices",
    TCO_CONVENTIONS.priceEscalationPct,
    "pct",
    "TCO_CONVENTIONS.priceEscalationPct",
    "Held flat: we hold no sourced escalation curve, and inventing one moves every candidate in the same direction.",
  );
  if (tco.batteryReplacementPaise > 0) {
    convention(
      ctx,
      "conventions.tco.batteryReplacementTaperYears",
      "Years over which owner-borne battery replacement tapers to zero",
      TCO_CONVENTIONS.batteryReplacementTaperYears,
      "years",
      "TCO_CONVENTIONS.batteryReplacementTaperYears",
    );
  }
}

function attributeCo2(ctx: Ctx, co2: Co2Breakdown): void {
  const factorId = ctx.refs.emissionFactorId;

  sourced(
    ctx,
    "co2.factor.gramsCo2ePerUnit",
    `Emission factor for ${co2.factor.fuelType}`,
    co2.factor.gramsCo2ePerUnit,
    `g CO2e/${co2.factor.unit}`,
    EMISSIONS,
    factorId,
    ["grams_co2e_per_unit"],
    `${co2.factor.scope}${co2.factor.stateCode === null ? ", national" : `, ${co2.factor.stateCode}`}, as of ${co2.factor.asOf}.`,
  );

  derived(
    ctx,
    "co2.appliedGramsCo2ePerUnit",
    "Per-unit factor actually applied, after blending",
    co2.appliedGramsCo2ePerUnit,
    `g CO2e/${co2.factor.unit}`,
    ["co2.factor.gramsCo2ePerUnit"],
    { via: { entityTable: EMISSIONS, entityId: factorId, fields: ["grams_co2e_per_unit"] } },
  );

  derived(
    ctx,
    "co2.effectiveEfficiency",
    "Real-world efficiency used in the division",
    co2.effectiveEfficiency,
    co2.efficiencyUnit,
    [],
    {
      via: {
        entityTable: VARIANTS,
        entityId: ctx.variantId,
        fields: ["real_world_efficiency_city", "real_world_efficiency_highway"],
      },
      note: "City and highway real-world figures blended at your city share, after any ethanol-blend penalty. ARAI claims are never used.",
    },
  );

  derived(
    ctx,
    "co2.gramsCo2ePerKm",
    "Counted well-to-wheel CO2e per kilometre",
    co2.gramsCo2ePerKm,
    "g CO2e/km",
    ["co2.appliedGramsCo2ePerUnit", "co2.effectiveEfficiency"],
    { note: "A rate, so it is carried unrounded." },
  );
  derived(ctx, "co2.annualGramsCo2e", "CO2e over one year", co2.annualGramsCo2e, "g CO2e", [
    "co2.gramsCo2ePerKm",
    "tco.totalKm",
  ]);
  derived(
    ctx,
    "co2.horizonGramsCo2e",
    "CO2e over the whole horizon",
    co2.horizonGramsCo2e,
    "g CO2e",
    ["co2.gramsCo2ePerKm", "tco.totalKm"],
  );

  /**
   * The biogenic figures are derived numbers *governed by* a convention, not
   * conventions themselves — so they are labelled `derived` and carry the
   * convention that decided where they sit. What matters is that the note
   * travels with the number: reported beside the total, never inside it.
   */
  derived(
    ctx,
    "co2.biogenicGramsCo2PerKm",
    "Biogenic tailpipe CO2 per kilometre, reported beside the total",
    co2.biogenicGramsCo2PerKm,
    "g CO2/km",
    ["co2.effectiveEfficiency"],
    {
      convention: "CO2_CONVENTIONS.countBiogenicCarbon",
      note: "Reported beside the counted total and never added to it. Combining the two would reverse that decision at the one point where it changes what a reader believes.",
    },
  );
  derived(
    ctx,
    "co2.horizonBiogenicGramsCo2",
    "Biogenic tailpipe CO2 over the horizon, reported beside the total",
    co2.horizonBiogenicGramsCo2,
    "g CO2",
    ["co2.biogenicGramsCo2PerKm", "tco.totalKm"],
    {
      convention: "CO2_CONVENTIONS.countBiogenicCarbon",
      note: "Never added to the counted horizon total.",
    },
  );
  convention(
    ctx,
    "conventions.co2.chargingLossPct",
    "Assumed losses between the meter and the pack",
    CO2_CONVENTIONS.chargingLossPct,
    "pct",
    "CO2_CONVENTIONS.chargingLossPct",
    "Not modelled, so the CO2 figure and the energy cost are computed off the same kilowatt-hours.",
  );

  const blend = co2.blend;
  if (blend === null) return;

  sourced(
    ctx,
    "co2.blend.ethanolSharePct",
    "Ethanol share of the fuel at the pump",
    blend.ethanolSharePct,
    "pct",
    null,
    undefined,
    [],
  );
  sourced(
    ctx,
    "co2.blend.efficiencyPenaltyPct",
    "Real-world efficiency lost to the blend",
    blend.efficiencyPenaltyPct,
    "pct",
    "e20_compatibility",
    ctx.refs.e20CompatibilityId,
    ["mileage_delta_min_pct", "mileage_delta_max_pct"],
    `Measured against a baseline of E${blend.baselineEthanolSharePct}.`,
  );
  sourced(
    ctx,
    "co2.blend.fossilGramsCo2ePerLitre",
    "Counted well-to-tank CO2e per litre of neat ethanol",
    blend.fossilGramsCo2ePerLitre,
    "g CO2e/litre",
    null,
    undefined,
    [],
  );
  sourced(
    ctx,
    "co2.blend.biogenicGramsCo2PerLitre",
    "Biogenic tailpipe CO2 per litre of neat ethanol",
    blend.biogenicGramsCo2PerLitre,
    "g CO2/litre",
    null,
    undefined,
    [],
  );
}

function attributeCommercial(ctx: Ctx, commercial: CommercialEconomics): void {
  derived(
    ctx,
    "commercial.capitalPaise",
    "Capital committed to acquire the vehicle",
    commercial.capitalPaise,
    "paise",
    ["tco.acquisitionPaise"],
  );
  derived(
    ctx,
    "commercial.kmPerOperatingDay",
    "Distance per operating day",
    commercial.kmPerOperatingDay,
    "km",
    ["tco.totalKm"],
    { note: "A sanity figure for you to check the profile against; it drives nothing." },
  );

  userInput(
    ctx,
    "commercial.base.revenuePaisePerKm",
    "Freight rate you stated",
    commercial.base.revenuePaisePerKm,
    "paise/km",
  );
  userInput(
    ctx,
    "commercial.base.driverCostPaisePerMonth",
    "Driver pay you stated",
    commercial.base.driverCostPaisePerMonth,
    "paise/month",
  );

  for (const scenario of [commercial.base, commercial.low, commercial.high]) {
    const p = `commercial.${scenario.label}`;
    const label = scenario.label === "base" ? "base case" : `${scenario.label} case`;
    const from = [
      "commercial.base.revenuePaisePerKm",
      "commercial.base.driverCostPaisePerMonth",
      "tco.totalPaise",
    ];

    derived(ctx, `${p}.grossRevenuePaise`, `Gross revenue, ${label}`, scenario.grossRevenuePaise, "paise", from);
    derived(ctx, `${p}.driverCostPaise`, `Driver pay over the horizon, ${label}`, scenario.driverCostPaise, "paise", from);
    derived(ctx, `${p}.operatingCostPaise`, `Cost of running it, ${label}`, scenario.operatingCostPaise, "paise", from);
    derived(ctx, `${p}.operatingMarginPaise`, `Operating margin, ${label}`, scenario.operatingMarginPaise, "paise", from);
    derived(
      ctx,
      `${p}.operatingMarginPctOfRevenue`,
      `Operating margin as a share of revenue, ${label}`,
      scenario.operatingMarginPctOfRevenue,
      "pct",
      from,
    );
    derived(ctx, `${p}.netProfitPaise`, `Net profit over the horizon, ${label}`, scenario.netProfitPaise, "paise", from);
    derived(ctx, `${p}.netMarginPaisePerKm`, `Net margin per kilometre, ${label}`, scenario.netMarginPaisePerKm, "paise/km", from);
    derived(ctx, `${p}.roiPct`, `Return on capital, ${label}`, scenario.roiPct, "pct", [...from, "commercial.capitalPaise"], {
      convention: "COMMERCIAL_CONVENTIONS.roiDenominator",
      note: "Measured against the capital committed, not the down payment.",
    });
    if (scenario.paybackMonth !== null) {
      derived(ctx, `${p}.paybackMonth`, `Month the vehicle pays back, ${label}`, scenario.paybackMonth, "months", from, {
        convention: "COMMERCIAL_CONVENTIONS.paybackExcludesResale",
        note: "Excludes the resale credit, which is only realised on exit.",
      });
    }
  }

  /** A swing the caller stated is their input; a swing we defaulted is our
   * convention. The two must not read the same — one is evidence about their
   * lanes, the other is a documented guess about lanes like theirs. */
  const supplied = commercial.sensitivitySource === "supplied";
  const sensitivityNote = supplied
    ? "The range you supplied."
    : "Our default for this duty cycle, not a sourced rate. Supply your own contracted range for a tighter answer.";

  if (supplied) {
    userInput(
      ctx,
      "commercial.sensitivity.revenueSwingPct",
      "Freight-rate swing either side of the stated figure",
      commercial.sensitivity.revenueSwingPct,
      "pct",
      sensitivityNote,
    );
    userInput(
      ctx,
      "commercial.sensitivity.driverCostSwingPct",
      "Driver-pay swing either side of the stated figure",
      commercial.sensitivity.driverCostSwingPct,
      "pct",
      sensitivityNote,
    );
  } else {
    convention(
      ctx,
      "commercial.sensitivity.revenueSwingPct",
      "Freight-rate swing either side of the stated figure",
      commercial.sensitivity.revenueSwingPct,
      "pct",
      "DEFAULT_SENSITIVITY_BY_DUTY_CYCLE",
      sensitivityNote,
    );
    convention(
      ctx,
      "commercial.sensitivity.driverCostSwingPct",
      "Driver-pay swing either side of the stated figure",
      commercial.sensitivity.driverCostSwingPct,
      "pct",
      "DEFAULT_SENSITIVITY_BY_DUTY_CYCLE",
      sensitivityNote,
    );
  }
}

/** Where each sub-score's `raw` figure actually comes from. */
function attributeSubScore(ctx: Ctx, sub: SubScore): void {
  const dimension = sub.dimension;
  const rawKey = `score.${dimension}.raw`;

  if (sub.raw !== null) {
    switch (dimension) {
      case "reliability":
        sourced(
          ctx,
          rawKey,
          "Authorised service centres nationally",
          sub.raw,
          sub.unit,
          "manufacturers",
          ctx.refs.manufacturerId,
          ["service_centre_count"],
        );
        break;
      case "resale":
        sourced(
          ctx,
          rawKey,
          "Used-market liquidity for this segment and fuel",
          sub.raw,
          sub.unit,
          "resale_curves",
          ctx.refs.resaleCurveId,
          ["liquidity_score"],
        );
        break;
      case "cost":
        derived(ctx, rawKey, "Total cost of ownership scored", sub.raw, sub.unit, [
          "tco.totalPaise",
        ]);
        break;
      case "environment":
        derived(ctx, rawKey, "CO2e per kilometre scored", sub.raw, sub.unit, [
          "co2.gramsCo2ePerKm",
        ]);
        break;
      case "profitability":
        derived(ctx, rawKey, "Net margin per kilometre scored", sub.raw, sub.unit, [
          "commercial.base.netMarginPaisePerKm",
        ]);
        break;
      case "payback":
        derived(ctx, rawKey, "Months to payback scored", sub.raw, sub.unit, [
          "commercial.base.paybackMonth",
        ]);
        break;
      case "usage":
        derived(ctx, rawKey, "Capacity and range fit index", sub.raw, sub.unit, [], {
          convention: "FIT_PARAMETERS",
          note: sub.note,
        });
        break;
      case "infrastructure":
        derived(ctx, rawKey, "Refuelling or charging access index", sub.raw, sub.unit, [], {
          convention: "FIT_PARAMETERS",
          note: sub.note,
        });
        break;
    }
  }

  if (sub.range !== null) {
    derived(
      ctx,
      `score.${dimension}.range.min`,
      `Lowest ${dimension} figure across the candidate set`,
      sub.range.min,
      sub.unit,
      [rawKey],
    );
    derived(
      ctx,
      `score.${dimension}.range.max`,
      `Highest ${dimension} figure across the candidate set`,
      sub.range.max,
      sub.unit,
      [rawKey],
    );
  }

  derived(
    ctx,
    `score.${dimension}.score`,
    `${dimension} sub-score`,
    sub.score,
    "score",
    [rawKey, `score.${dimension}.range.min`, `score.${dimension}.range.max`],
    {
      note: sub.discriminating
        ? "0–100 within this candidate set, so it ranks rather than grades."
        : "Every candidate tied here, so the dimension cannot order them.",
    },
  );
  derived(
    ctx,
    `score.${dimension}.weight`,
    `Weight applied to ${dimension} for this vehicle`,
    sub.weight,
    "weight",
    [],
    {
      convention: "BASE_WEIGHTS",
      note: "The persona weight after the weight of anything unscored was redistributed across what could be scored.",
    },
  );
}

/* -------------------------------------------------------------------------- */
/* The why-not contrast                                                        */
/* -------------------------------------------------------------------------- */

const dimensionOrder = (dimension: ScoreDimension) =>
  SCORE_DIMENSIONS.indexOf(dimension);

/** Verbatim. Locale-aware number formatting has no place in a pure function: it
 * would replay differently on a different machine, and it would put a grouped
 * string in front of the guard that has to match it against a bare number. */
const figure = (value: number | null): string =>
  value === null ? "no figure" : String(value);

function buildContrast(
  winner: ExplainedVehicle,
  contender: ExplainedVehicle,
): Contrast {
  const winnerBy = new Map(winner.subScores.map((s) => [s.dimension, s]));
  const contenderBy = new Map(contender.subScores.map((s) => [s.dimension, s]));

  const deltas: ScoreDelta[] = [];
  for (const dimension of SCORE_DIMENSIONS) {
    const w = winnerBy.get(dimension);
    const c = contenderBy.get(dimension);
    if (w === undefined && c === undefined) continue;

    const winnerScore = w?.score ?? null;
    const contenderScore = c?.score ?? null;
    const winnerWeight = w?.weight ?? 0;
    const contenderWeight = c?.weight ?? 0;

    deltas.push({
      dimension,
      winnerScore,
      contenderScore,
      winnerWeight,
      contenderWeight,
      winnerRaw: w?.raw ?? null,
      contenderRaw: c?.raw ?? null,
      unit: w?.unit ?? c?.unit ?? "index",
      direction: w?.direction ?? c?.direction ?? "higher_is_better",
      range: w?.range ?? c?.range ?? null,
      contribution: round2(
        (winnerScore ?? 0) * winnerWeight - (contenderScore ?? 0) * contenderWeight,
      ),
      dataGap: winnerScore === null || contenderScore === null,
    });
  }

  deltas.sort(
    (a, b) =>
      Math.abs(b.contribution) - Math.abs(a.contribution) ||
      dimensionOrder(a.dimension) - dimensionOrder(b.dimension),
  );

  // A dimension only carried a result if the two vehicles actually scored
  // differently on it. Contribution alone cannot be trusted for that:
  //
  //  - `dataGap` means one side has no figure at all. That is something we do
  //    not know about it, not something the other vehicle beat it on.
  //  - Equal scores can still produce a non-zero contribution, because a side
  //    carrying an unscored dimension has that weight redistributed into the
  //    rest. Two vehicles tied at 50 then differ only in weight, and the
  //    dimension looks decisive when nothing separated them.
  //
  // Both would put a claim in the payload that the numbers do not support, and
  // the payload is the only thing the narrator is allowed to speak from.
  const decisive = (d: ScoreDelta) =>
    !d.dataGap && d.winnerScore !== d.contenderScore;

  const decidedBy = deltas
    .filter((d) => d.contribution > 0 && decisive(d))
    .slice(0, 3)
    .map((d) => d.dimension);
  const contenderWonOn = deltas
    .filter((d) => d.contribution < 0 && decisive(d))
    .map((d) => d.dimension);

  const totalScoreGap = round2(winner.totalScore - contender.totalScore);
  // Prefer a genuinely decisive lead; fall back to the largest positive delta so
  // the data-gap sentence below still has something to report.
  const lead =
    deltas.find((d) => d.contribution > 0 && decisive(d)) ??
    deltas.find((d) => d.contribution > 0);

  const sentences: string[] = [
    totalScoreGap === 0
      ? `${winner.name} and ${contender.name} score the same overall, at ${winner.totalScore} points each.`
      : `${winner.name} leads ${contender.name} by ${totalScoreGap} points, ${winner.totalScore} against ${contender.totalScore}.`,
  ];

  if (lead !== undefined) {
    sentences.push(
      lead.dataGap
        ? `The largest single difference is ${lead.dimension}, but only because one of the two carries no figure for it — a gap in what we know, not a defeat.`
        : `The biggest single difference is ${lead.dimension}: ${figure(lead.winnerRaw)} ${lead.unit} against ${figure(lead.contenderRaw)} ${lead.unit}.`,
    );
  }

  if (contenderWonOn.length > 0) {
    sentences.push(
      `${contender.name} is the better vehicle on ${contenderWonOn.join(", ")}.`,
    );
  }

  return {
    winnerVariantId: winner.variantId,
    winnerName: winner.name,
    contenderVariantId: contender.variantId,
    contenderName: contender.name,
    totalScoreGap,
    deltas,
    decidedBy,
    contenderWonOn,
    summary: sentences.join(" "),
  };
}

/* -------------------------------------------------------------------------- */
/* Sources                                                                     */
/* -------------------------------------------------------------------------- */

/** Only rows a number in this answer actually cited become a source. A
 * provenance row for a field no ranked vehicle used is not a source of *this*
 * answer, and listing it would overstate what has been checked. */
function collectSources(cited: readonly ProvenanceRecord[]): CitedSource[] {
  const bySource = new Map<string, CitedSource>();
  const seen = new Set<string>();

  for (const record of cited) {
    let entry = bySource.get(record.sourceId);
    if (entry === undefined) {
      entry = {
        sourceId: record.sourceId,
        slug: record.sourceSlug,
        name: record.sourceName,
        tier: record.tier,
        url: record.sourceUrl ?? null,
        fields: [],
      };
      bySource.set(record.sourceId, entry);
    }

    const fingerprint = `${record.sourceId} ${refKey(record.entityTable, record.entityId, record.field)}`;
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);

    entry.fields.push({
      entityTable: record.entityTable,
      entityId: record.entityId,
      field: record.field,
      confidence: record.confidence,
      verifiedAt: record.verifiedAt,
      excerpt: record.excerpt ?? null,
    });
  }

  const sources = [...bySource.values()].sort((a, b) =>
    a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0,
  );
  for (const source of sources) {
    source.fields.sort((a, b) => {
      const left = refKey(a.entityTable, a.entityId, a.field);
      const right = refKey(b.entityTable, b.entityId, b.field);
      return left < right ? -1 : left > right ? 1 : 0;
    });
  }
  return sources;
}

/* -------------------------------------------------------------------------- */
/* Stage 5 end to end                                                          */
/* -------------------------------------------------------------------------- */

export function runStage5(input: Stage5Input): Stage5Result {
  const { profile, asOf, engineVersion, stage1, candidates, stage3, stage4 } = input;

  /**
   * `stage3.scored` is in **input order** and `stage4.ranked` is in **rank
   * order**. Joining by index would silently rank one vehicle under another's
   * numbers, so both sides are joined by id and a miss is a typed failure —
   * the same doctrine stage 4 applies to its own pairing.
   */
  const byVariantId = new Map(candidates.map((c) => [c.variant.variantId, c]));
  const scoreById = new Map(stage3.scored.map((s) => [s.variantId, s]));

  const index = indexProvenance(input.provenance ?? []);
  const cited: ProvenanceRecord[] = [];
  const unattributed: UnattributedNumber[] = [];

  const vehicles: ExplainedVehicle[] = [];
  for (const ranked of stage4.ranked) {
    const candidate = byVariantId.get(ranked.variantId);
    if (candidate === undefined) {
      return {
        ok: false,
        code: "candidate_missing",
        reason: `Rank ${ranked.rank} is ${ranked.variantId}, which is not in the candidate set stage 3 and 4 were given.`,
      };
    }
    const score = scoreById.get(ranked.variantId);
    if (score === undefined) {
      return {
        ok: false,
        code: "score_missing",
        reason: `Rank ${ranked.rank} is ${ranked.variantId}, which carries no stage-3 score.`,
      };
    }

    const ctx: Ctx = {
      variantId: ranked.variantId,
      refs: input.references?.[ranked.variantId] ?? {},
      index,
      out: [],
      cited,
      unattributed,
    };

    attributeVariant(ctx, candidate.variant);
    attributePrice(ctx, candidate.price);
    attributeTco(ctx, candidate.tco);
    if (candidate.co2 !== null) attributeCo2(ctx, candidate.co2);
    if (candidate.commercial !== null) attributeCommercial(ctx, candidate.commercial);
    for (const sub of score.subScores) attributeSubScore(ctx, sub);

    derived(
      ctx,
      "totalScore",
      "Overall score",
      ranked.totalScore,
      "score",
      score.subScores.flatMap((s) => [
        `score.${s.dimension}.score`,
        `score.${s.dimension}.weight`,
      ]),
      { note: "The weighted mean of the dimensions this vehicle could be scored on." },
    );

    vehicles.push({
      rank: ranked.rank,
      variantId: ranked.variantId,
      modelId: ranked.modelId,
      name: ranked.name,
      fuelType: ranked.fuelType,
      totalScore: ranked.totalScore,
      selectedBy: ranked.selectedBy,
      bestInFuel: ranked.bestInFuel,
      variant: candidate.variant,
      price: candidate.price,
      tco: candidate.tco,
      co2: candidate.co2,
      commercial: candidate.commercial,
      subScores: score.subScores,
      unscored: score.unscored,
      attributions: ctx.out,
      assumptions: [
        ...candidate.tco.assumptions,
        ...(candidate.co2?.assumptions ?? []),
        ...(candidate.commercial?.assumptions ?? []),
      ],
    });
  }

  /** The one figure this stage creates per vehicle, and the only call it makes
   * into an earlier module: the number the narrative needs for "pays back in N
   * months against the top pick". Rank 1 is its own baseline. */
  const topPick = vehicles[0];
  if (topPick !== undefined) {
    for (const vehicle of vehicles) {
      if (vehicle.rank === topPick.rank) continue;
      vehicle.breakEvenMonthVsTopPick = breakEvenMonth(vehicle.tco, topPick.tco);
    }
  }

  const contrast =
    vehicles.length >= 2 ? buildContrast(vehicles[0], vehicles[1]) : null;

  const exclusionCounts: Partial<Record<ExclusionCode, number>> = {};
  for (const exclusion of stage1.exclusions) {
    exclusionCounts[exclusion.code] = (exclusionCounts[exclusion.code] ?? 0) + 1;
  }

  /**
   * One ordered set, exactly as stage 3 builds its own. Stage-2 assumptions
   * are per-variant and frequently name no vehicle, so they are prefixed
   * before being flattened — two vehicles' distinct lines deduped together
   * would read as one global claim. Only ranked vehicles contribute; every
   * vehicle keeps its unprefixed copy.
   */
  const assumptions = new Set<string>();
  for (const line of stage1.assumptions) assumptions.add(line);
  for (const vehicle of vehicles) {
    for (const line of vehicle.assumptions) assumptions.add(`${vehicle.name}: ${line}`);
  }
  for (const line of stage3.assumptions) assumptions.add(line);
  for (const line of stage4.assumptions) assumptions.add(line);

  if (unattributed.length > 0) {
    const fields = [
      ...new Set(
        unattributed.map((u) => (u.entityTable === null ? u.key : `${u.entityTable}.${u.field}`)),
      ),
    ].sort();
    assumptions.add(
      `${unattributed.length} ${unattributed.length === 1 ? "figure is" : "figures are"} not yet traced to a source in this result: ${fields.join(", ")}. They are listed in full under data.unattributed.`,
    );
  }

  return {
    ok: true,
    payload: {
      data: {
        run: {
          asOf,
          engineVersion,
          profile,
          candidateCount: candidates.length,
          rankedCount: vehicles.length,
          excludedCount: stage1.exclusions.length,
          omittedCount: stage4.omitted.length,
        },
        weights: stage3.weights,
        weightBasis: stage3.weightBasis,
        vehicles,
        contrast,
        exclusions: stage1.exclusions,
        exclusionCounts,
        omissions: stage4.omitted,
        conventions: {
          tco: TCO_CONVENTIONS,
          co2: CO2_CONVENTIONS,
          commercial: COMMERCIAL_CONVENTIONS,
          commercialSensitivityDefaults: DEFAULT_SENSITIVITY_BY_DUTY_CYCLE,
          scoring: SCORING_CONVENTIONS,
          gates: GATE_THRESHOLDS,
          fit: FIT_PARAMETERS,
          baseWeights: BASE_WEIGHTS,
          neutralScore: NEUTRAL_SCORE,
          diversification: {
            maxVariantsPerModel: MAX_VARIANTS_PER_MODEL,
            minDistinctFuels: MIN_DISTINCT_FUELS,
            defaultResultLimit: DEFAULT_RESULT_LIMIT,
          },
        },
        unattributed,
      },
      assumptions: [...assumptions],
      sources: collectSources(cited),
    },
  };
}
