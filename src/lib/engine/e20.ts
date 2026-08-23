import type {
  BodyType,
  ConfidenceLevel,
  E20Verdict,
  EmissionNorm,
  FuelType,
  RiskLevel,
} from "./enums";
import { RISK_LEVELS } from "./enums";

/**
 * Journey B — the E20 compatibility rules engine.
 *
 * This is the highest-liability code in the product. A wrong answer here does
 * not cost a user money on a spreadsheet, it costs them a fuel pump. So the
 * whole file is built around one ordering:
 *
 *   1. **What the OEM said**, where a compatibility row carries a statement.
 *      Never contradicted, never second-guessed (FR-B9).
 *   2. **What the emission norm implies**, where no statement exists. Reported
 *      as an inference and labelled as one (FR-B4).
 *   3. **`unknown`**, where neither is available. Never a guess (FR-B5).
 *
 * No LLM runs here. The verdict, the risk level, the mileage band and the
 * guidance rows are all chosen deterministically; the model downstream only
 * puts them into sentences.
 */

/** The vehicle the user says they already own. */
export interface AssessedVehicle {
  variantId: string;
  modelId: string;
  name: string;
  bodyType: BodyType;
  fuelType: FuelType;
  /** `null` when the catalogue does not record it. The norm rule then cannot
   * fire, and the verdict falls to `unknown` rather than to a default. */
  emissionNorm: EmissionNorm | null;
  /** Calendar year of manufacture as the owner reports it — not the model year,
   * which OEMs move mid-calendar and owners routinely misremember. */
  manufactureYear: number;
  odometerKm: number | null;
}

/**
 * One `e20_compatibility` row, projected into plain data. `numeric` columns
 * arrive as numbers and `date` columns as ISO `YYYY-MM-DD` strings, because the
 * engine never imports `src/db/`.
 */
export interface E20CompatibilityRecord {
  id: string;
  modelId: string | null;
  variantId: string | null;
  appliesFrom: string | null;
  appliesTo: string | null;
  verdict: E20Verdict;
  materialRiskLevel: RiskLevel;
  mileageDeltaMinPct: number | null;
  mileageDeltaMaxPct: number | null;
  oemStatementUrl: string | null;
  oemStatementSummary: string | null;
  sourceId: string | null;
  confidence: ConfidenceLevel;
  inferredFromNorm: boolean;
}

/** One `e20_guidance_rules` row, projected. */
export interface E20GuidanceRule {
  id: string;
  /** inspection | service_interval | driving_habit | component_upgrade | fuel_practice */
  kind: string;
  appliesToVerdict: E20Verdict;
  minRiskLevel: RiskLevel;
  /** Empty means "every body type" — the table stores `[]`, not `null`. */
  appliesToBodyTypes: readonly string[];
  appliesToMaxYear: number | null;
  title: string;
  detail: string;
  priority: number;
  sourceId: string | null;
}

/** Where the verdict came from. Drives the label the UI must show (FR-B4). */
export type E20Basis =
  /** An explicit OEM position held in the compatibility table. */
  | "oem_statement"
  /** Derived from the vehicle's emission norm, by row or by rule. */
  | "inferred_from_norm"
  /** The powertrain settles it: diesel and EVs never see the blend, flex-fuel
   * vehicles are built for far more of it than E20. */
  | "fuel_type"
  /** Nothing to go on. */
  | "no_data";

/** FR-B6 — always a band, never a point estimate. */
export interface MileageDelta {
  /** Percent loss versus E10, lower bound. Positive numbers mean a loss. */
  minPct: number;
  maxPct: number;
}

export interface ServiceIntervalAdjustment {
  /** Shorten the OEM interval by this percentage. The engine holds no OEM
   * interval, so it recommends a proportion rather than a distance. */
  shortenByPct: number;
  reason: string;
}

export interface E20Assessment {
  variantId: string;
  name: string;
  verdict: E20Verdict;
  basis: E20Basis;
  /** True when the verdict is an inference rather than an OEM position. The UI
   * must say so out loud (FR-B4). */
  inferredFromNorm: boolean;
  confidence: ConfidenceLevel;
  /** What the row or the norm rule says about the vehicle as built. */
  baseRiskLevel: RiskLevel;
  /** `baseRiskLevel`, escalated where the vehicle's age compounds it. */
  materialRiskLevel: RiskLevel;
  riskEscalatedByAge: boolean;
  mileageDelta: MileageDelta | null;
  serviceIntervalAdjustment: ServiceIntervalAdjustment | null;
  /** Every applicable guidance row, most important first. */
  guidance: E20GuidanceRule[];
  /** The `inspection` subset, as a checklist the UI renders directly. */
  inspectionChecklist: E20GuidanceRule[];
  /** Verbatim from the compatibility row. The narrative may never contradict
   * this (FR-B9), so it is carried through to be shown alongside the prose. */
  oemStatementSummary: string | null;
  oemStatementUrl: string | null;
  /** Finished sentences explaining how the verdict was reached. Doubles as the
   * deterministic fallback when the narrative model is unavailable. */
  reasons: string[];
  /** Where a rule could not be applied, and what was assumed instead. */
  assumptions: string[];
  /** `sources` rows every claim above resolves to (FR-B8). */
  sourceIds: string[];
}

/**
 * The rules, exported as data so the explainability payload and the docs can
 * cite the number that produced an answer rather than restating it.
 */
export const E20_RULES = {
  /**
   * The verdict implied by the emission norm when no compatibility row applies.
   *
   * BS-VI phase 2 (April 2023 onward) is the dividing line: E20 *material*
   * compatibility became a type-approval requirement at that point, which is
   * why it is the only norm that infers to compliant. BS-VI phase 1 vehicles
   * (2020–2023) are materially sound but calibrated for E10, so they run E20
   * safely and lose a little economy. BS-IV and older predate any ethanol
   * requirement, and their fuel-contact elastomers and aluminium were never
   * specified against it.
   */
  verdictByNorm: {
    bs3: "e10_only",
    bs4: "e10_only",
    bs6_phase1: "e20_tolerant",
    bs6_phase2: "e20_compliant",
    zero_emission: "not_applicable",
  } satisfies Record<EmissionNorm, E20Verdict>,

  /** Material risk implied by the same norms, for the same reasons. */
  riskByNorm: {
    bs3: "high",
    bs4: "moderate",
    bs6_phase1: "low",
    bs6_phase2: "none",
    zero_emission: "none",
  } satisfies Record<EmissionNorm, RiskLevel>,

  /**
   * How far to trust the norm rule. A BS-VI phase 2 inference rests on a
   * type-approval requirement that applied to every vehicle in the class, so it
   * is medium. Every other norm infers from the *absence* of a requirement,
   * which says nothing about what a particular OEM chose to do anyway — low.
   */
  confidenceByNorm: {
    bs3: "low",
    bs4: "low",
    bs6_phase1: "low",
    bs6_phase2: "medium",
    zero_emission: "medium",
  } satisfies Record<EmissionNorm, ConfidenceLevel>,

  /**
   * Efficiency loss on E20 versus E10, as a band.
   *
   * The floor of this is arithmetic, not opinion: ethanol carries about a third
   * less energy per litre than petrol, so moving from 10% to 20% ethanol
   * removes roughly 3.3% of the energy in a tank. What varies is how much of
   * that an engine gets back. A vehicle calibrated for E20 recovers most of it
   * through compression ratio and spark timing; one calibrated for E10 runs
   * slightly lean-corrected and recovers some through closed-loop trim; one
   * built before any ethanol requirement recovers the least.
   */
  mileageDeltaByVerdict: {
    e20_compliant: { minPct: 1, maxPct: 2 },
    e20_tolerant: { minPct: 2, maxPct: 4 },
    e10_only: { minPct: 3, maxPct: 6 },
    not_applicable: null,
    unknown: null,
  } satisfies Record<E20Verdict, MileageDelta | null>,

  /**
   * How much to shorten service intervals by, per risk level.
   *
   * Ethanol is hygroscopic and a mild solvent: it lifts deposits that an older
   * fuel system has spent years laying down, and it carries more dissolved
   * water to the filter. The higher the material risk, the more that argues for
   * seeing the filter and the oil sooner than the book says.
   */
  serviceIntervalShorteningByRisk: {
    none: 0,
    low: 10,
    moderate: 20,
    high: 25,
  } satisfies Record<RiskLevel, number>,

  /**
   * Age at which material risk escalates one level.
   *
   * Fuel-line rubber and tank seals perish on their own timetable, and a
   * vehicle old enough for that has less margin left to give to a more
   * aggressive fuel. Escalation deliberately never fires on a `none` base: a
   * vehicle certified E20-material-compliant has no ethanol-specific exposure
   * to compound, and inventing one would contradict its OEM position (FR-B9).
   */
  ageRiskEscalationYears: 15,
} as const;

/**
 * Powertrains the blend never reaches. Diesel and hydrogen do not burn petrol;
 * an EV has no fuel system at all.
 */
const NON_PETROL_FUELS: readonly FuelType[] = ["diesel", "electric", "hydrogen"];

/**
 * Gaseous fuels that still have a petrol problem. Every factory CNG and LPG
 * fitment sold in India is bi-fuel — it keeps a petrol tank and, in most cases,
 * starts on petrol before switching over. The blend reaches the engine, and the
 * petrol side of the fuel system sits idle for long stretches, which is exactly
 * the condition ethanol's water affinity punishes.
 */
const BI_FUEL_WITH_PETROL: readonly FuelType[] = ["cng", "lpg"];

const riskRank = (level: RiskLevel) => RISK_LEVELS.indexOf(level);

/** True when `level` is at least as severe as `floor`. */
export const meetsRiskFloor = (level: RiskLevel, floor: RiskLevel) =>
  riskRank(level) >= riskRank(floor);

const escalateRisk = (level: RiskLevel): RiskLevel =>
  RISK_LEVELS[Math.min(riskRank(level) + 1, RISK_LEVELS.length - 1)];

const CONFIDENCE_RANK: Record<ConfidenceLevel, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

/**
 * Does this row's validity window cover any part of the manufacture year?
 *
 * FR-B3 requires that a row whose window excludes the year is not used. We hold
 * a year and the row holds dates, so the honest test is intersection rather
 * than containment: a row running from April 2023 genuinely does describe some
 * vehicles built in 2023. Where the overlap is partial the row is used and the
 * ambiguity is recorded, because the alternative — discarding it — would answer
 * `unknown` for a vehicle we very likely do have data for.
 */
const windowCoversYear = (row: E20CompatibilityRecord, year: number) => {
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;
  return (
    (row.appliesFrom === null || row.appliesFrom <= yearEnd) &&
    (row.appliesTo === null || row.appliesTo >= yearStart)
  );
};

/** True when the row's window covers only part of the manufacture year. */
const windowIsPartial = (row: E20CompatibilityRecord, year: number) =>
  (row.appliesFrom !== null && row.appliesFrom > `${year}-01-01`) ||
  (row.appliesTo !== null && row.appliesTo < `${year}-12-31`);

/** Rows scoped to this exact variant, or to its model with no variant narrowing. */
const scopeOf = (
  row: E20CompatibilityRecord,
  vehicle: AssessedVehicle,
): "variant" | "model" | null => {
  if (row.variantId !== null) {
    return row.variantId === vehicle.variantId ? "variant" : null;
  }
  return row.modelId === vehicle.modelId ? "model" : null;
};

/** Days a row's window spans; unbounded windows sort last as the least specific. */
const windowSpecificity = (row: E20CompatibilityRecord) => {
  if (row.appliesFrom === null || row.appliesTo === null) {
    return Number.POSITIVE_INFINITY;
  }
  return Date.parse(row.appliesTo) - Date.parse(row.appliesFrom);
};

/**
 * Pick the one row that answers for this vehicle (FR-B2).
 *
 * Precedence, in order: variant scope over model scope, because within one
 * model a 2019 BS-IV car and a 2024 BS-VI phase 2 car have genuinely different
 * answers; then a stated OEM position over a norm-inferred one; then
 * confidence; then the narrower window, as the more deliberately scoped row.
 * The row id breaks any remaining tie so that two runs over the same data
 * cannot disagree (FR-A12 applies to Journey B too).
 */
export function selectCompatibilityRow(
  rows: readonly E20CompatibilityRecord[],
  vehicle: AssessedVehicle,
): E20CompatibilityRecord | null {
  const applicable = rows
    .map((row) => ({ row, scope: scopeOf(row, vehicle) }))
    .filter(
      (entry): entry is { row: E20CompatibilityRecord; scope: "variant" | "model" } =>
        entry.scope !== null && windowCoversYear(entry.row, vehicle.manufactureYear),
    );

  if (applicable.length === 0) return null;

  applicable.sort((a, b) => {
    if (a.scope !== b.scope) return a.scope === "variant" ? -1 : 1;
    if (a.row.inferredFromNorm !== b.row.inferredFromNorm) {
      return a.row.inferredFromNorm ? 1 : -1;
    }
    const confidence =
      CONFIDENCE_RANK[a.row.confidence] - CONFIDENCE_RANK[b.row.confidence];
    if (confidence !== 0) return confidence;
    // Subtraction would give NaN for two unbounded windows, and a NaN
    // comparator silently abandons the id tie-break below.
    const aSpan = windowSpecificity(a.row);
    const bSpan = windowSpecificity(b.row);
    if (aSpan !== bSpan) return aSpan < bSpan ? -1 : 1;
    return a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0;
  });

  return applicable[0].row;
}

/**
 * Guidance selection (FR-B7) — deterministic, and entirely the engine's job.
 *
 * A row applies when its verdict matches, the vehicle's material risk reaches
 * its floor, its body-type narrowing includes this vehicle, and its year
 * ceiling has not been passed. Sorted by priority, then title, so the UI's
 * "top few, rest collapsed" is stable across runs.
 */
export function selectGuidance(
  rules: readonly E20GuidanceRule[],
  verdict: E20Verdict,
  risk: RiskLevel,
  vehicle: AssessedVehicle,
): E20GuidanceRule[] {
  return rules
    .filter((rule) => {
      if (rule.appliesToVerdict !== verdict) return false;
      if (!meetsRiskFloor(risk, rule.minRiskLevel)) return false;
      if (
        rule.appliesToBodyTypes.length > 0 &&
        !rule.appliesToBodyTypes.includes(vehicle.bodyType)
      ) {
        return false;
      }
      if (
        rule.appliesToMaxYear !== null &&
        vehicle.manufactureYear > rule.appliesToMaxYear
      ) {
        return false;
      }
      return true;
    })
    .sort(
      (a, b) =>
        a.priority - b.priority ||
        (a.title < b.title ? -1 : a.title > b.title ? 1 : 0),
    );
}

export interface E20AssessmentInput {
  vehicle: AssessedVehicle;
  /** Candidate `e20_compatibility` rows for this variant and its model. */
  compatibility: readonly E20CompatibilityRecord[];
  guidanceRules: readonly E20GuidanceRule[];
  /** Calendar year the assessment is run in. Passed in, never read from the
   * clock, so a stored assessment replays to the same result. */
  asOfYear: number;
}

/**
 * Assess one vehicle against E20.
 *
 * The resolution order is the file's whole argument, so it is worth stating
 * plainly: powertrain first, because it can settle the question outright; then
 * the compatibility table, which is where OEM positions live; then the norm
 * rule; then `unknown`. Nothing below a step can override something above it.
 */
export function assessE20(input: E20AssessmentInput): E20Assessment {
  const { vehicle, compatibility, guidanceRules, asOfYear } = input;
  const reasons: string[] = [];
  const assumptions: string[] = [];
  const sourceIds = new Set<string>();

  const base = {
    variantId: vehicle.variantId,
    name: vehicle.name,
    oemStatementSummary: null,
    oemStatementUrl: null,
    riskEscalatedByAge: false,
    serviceIntervalAdjustment: null,
    guidance: [] as E20GuidanceRule[],
    inspectionChecklist: [] as E20GuidanceRule[],
  };

  // 1. Powertrains the blend never reaches. No table lookup can change this.
  if (NON_PETROL_FUELS.includes(vehicle.fuelType)) {
    return {
      ...base,
      verdict: "not_applicable",
      basis: "fuel_type",
      inferredFromNorm: false,
      confidence: "high",
      baseRiskLevel: "none",
      materialRiskLevel: "none",
      mileageDelta: null,
      reasons: [
        `${vehicle.name} does not run on petrol, so the ethanol blend in petrol does not reach it.`,
      ],
      assumptions,
      sourceIds: [],
    };
  }

  let verdict: E20Verdict;
  let basis: E20Basis;
  let inferredFromNorm: boolean;
  let confidence: ConfidenceLevel;
  let baseRiskLevel: RiskLevel;
  let mileageDelta: MileageDelta | null;
  let oemStatementSummary: string | null = null;
  let oemStatementUrl: string | null = null;

  const row = selectCompatibilityRow(compatibility, vehicle);

  if (row !== null) {
    // 2. The compatibility table answers (FR-B2). Its verdict stands as written.
    verdict = row.verdict;
    inferredFromNorm = row.inferredFromNorm;
    basis = row.inferredFromNorm ? "inferred_from_norm" : "oem_statement";
    confidence = row.confidence;
    baseRiskLevel = row.materialRiskLevel;
    oemStatementSummary = row.oemStatementSummary;
    oemStatementUrl = row.oemStatementUrl;
    if (row.sourceId !== null) sourceIds.add(row.sourceId);

    if (row.mileageDeltaMinPct !== null && row.mileageDeltaMaxPct !== null) {
      mileageDelta = {
        minPct: row.mileageDeltaMinPct,
        maxPct: row.mileageDeltaMaxPct,
      };
    } else {
      // FR-B6 wants both bounds. A half-populated row cannot give them, so the
      // verdict's own band stands in and the substitution is declared.
      mileageDelta = E20_RULES.mileageDeltaByVerdict[verdict];
      if (mileageDelta !== null) {
        assumptions.push(
          `No measured efficiency figures are on file for ${vehicle.name}, so the ${mileageDelta.minPct}–${mileageDelta.maxPct}% band typical of ${verdict.replace(/_/g, " ")} vehicles is used instead.`,
        );
      }
    }

    reasons.push(
      row.inferredFromNorm
        ? `This verdict is inferred from the vehicle's emission norm, not from a published statement by the manufacturer.`
        : `The manufacturer has published a position on E20 for this vehicle, and it is reported here unchanged.`,
    );
  } else if (vehicle.fuelType === "flex_fuel") {
    // 3a. A flex-fuel vehicle is built for blends far past E20 by definition.
    verdict = "e20_compliant";
    basis = "fuel_type";
    inferredFromNorm = false;
    confidence = "high";
    baseRiskLevel = "none";
    mileageDelta = E20_RULES.mileageDeltaByVerdict.e20_compliant;
    reasons.push(
      `${vehicle.name} is a flex-fuel vehicle, built to run on ethanol blends well beyond E20.`,
    );
  } else if (vehicle.emissionNorm === null) {
    // 3b. Nothing to reason from. Say so (FR-B5).
    verdict = "unknown";
    basis = "no_data";
    inferredFromNorm = false;
    confidence = "low";
    baseRiskLevel = "none";
    mileageDelta = null;
    reasons.push(
      `We hold no E20 compatibility record for ${vehicle.name}, and its emission norm is not on file either, so there is no basis for a verdict.`,
    );
  } else {
    // 3c. The norm rule (FR-B4). An inference, labelled as one.
    verdict = E20_RULES.verdictByNorm[vehicle.emissionNorm];
    basis = "inferred_from_norm";
    inferredFromNorm = true;
    confidence = E20_RULES.confidenceByNorm[vehicle.emissionNorm];
    baseRiskLevel = E20_RULES.riskByNorm[vehicle.emissionNorm];
    mileageDelta = E20_RULES.mileageDeltaByVerdict[verdict];
    reasons.push(
      `No manufacturer statement is on file for ${vehicle.name}, so this verdict is inferred from its ${NORM_LABELS[vehicle.emissionNorm]} emission norm.`,
    );
  }

  // Age escalation. Never fires on a `none` base — see E20_RULES.
  const age = asOfYear - vehicle.manufactureYear;
  let materialRiskLevel = baseRiskLevel;
  let riskEscalatedByAge = false;
  if (
    baseRiskLevel !== "none" &&
    age >= E20_RULES.ageRiskEscalationYears
  ) {
    materialRiskLevel = escalateRisk(baseRiskLevel);
    riskEscalatedByAge = materialRiskLevel !== baseRiskLevel;
    if (riskEscalatedByAge) {
      reasons.push(
        `At ${age} years old, the fuel lines and seals have aged on their own account, which leaves less margin for a more aggressive fuel — the risk is raised from ${baseRiskLevel} to ${materialRiskLevel}.`,
      );
    }
  }

  if (row !== null && windowIsPartial(row, vehicle.manufactureYear)) {
    assumptions.push(
      `The compatibility record covers only part of ${vehicle.manufactureYear}. We hold your year of manufacture but not your month, so it is assumed to apply.`,
    );
  }

  if (vehicle.odometerKm === null) {
    assumptions.push(
      "No odometer reading was given, so guidance is based on the vehicle's age alone.",
    );
  }

  if (BI_FUEL_WITH_PETROL.includes(vehicle.fuelType)) {
    assumptions.push(
      `${vehicle.name} runs on ${vehicle.fuelType.toUpperCase()}, and is assessed as a bi-fuel vehicle that also carries petrol. If it has been converted to run on gas alone, the blend never reaches it and this assessment does not apply.`,
    );
  }

  const guidance = selectGuidance(
    guidanceRules,
    verdict,
    materialRiskLevel,
    vehicle,
  );
  for (const rule of guidance) {
    if (rule.sourceId !== null) sourceIds.add(rule.sourceId);
  }

  const shortenByPct =
    E20_RULES.serviceIntervalShorteningByRisk[materialRiskLevel];

  return {
    variantId: vehicle.variantId,
    name: vehicle.name,
    verdict,
    basis,
    inferredFromNorm,
    confidence,
    baseRiskLevel,
    materialRiskLevel,
    riskEscalatedByAge,
    mileageDelta,
    serviceIntervalAdjustment:
      shortenByPct > 0
        ? {
            shortenByPct,
            reason: `Ethanol lifts deposits an older fuel system has laid down and carries more water to the filter. At ${materialRiskLevel} material risk, that argues for seeing the fuel filter and engine oil about ${shortenByPct}% sooner than the manual specifies.`,
          }
        : null,
    guidance,
    inspectionChecklist: guidance.filter((rule) => rule.kind === "inspection"),
    oemStatementSummary,
    oemStatementUrl,
    reasons,
    assumptions,
    sourceIds: [...sourceIds].sort(),
  };
}

/** How each norm is named to a user, who has never heard of `bs6_phase2`. */
const NORM_LABELS: Record<EmissionNorm, string> = {
  bs3: "BS-III",
  bs4: "BS-IV",
  bs6_phase1: "BS-VI phase 1",
  bs6_phase2: "BS-VI phase 2",
  zero_emission: "zero-emission",
};
