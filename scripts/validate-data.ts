/**
 * Data quality + coverage report.
 *
 *   pnpm db:validate                        # full report, gate at 90%
 *   pnpm db:validate --json                 # machine-readable
 *   pnpm db:validate --only=vehicle_variants
 *   pnpm db:validate --min-coverage=95 --stale-days=90
 *   pnpm db:validate --strict               # an empty curated table is a failure
 *
 * WHAT IT CHECKS
 *   1. Per-table completeness — how many rows actually carry each fact-bearing
 *      column, with an honest denominator: a petrol car is not "missing" a
 *      battery chemistry, so conditional columns declare the population they
 *      apply to and are measured only against it.
 *   2. fact_provenance coverage — for every populated fact, is there a current
 *      (superseded_at is null) provenance row? CLAUDE.md: a number never
 *      reaches a user unattributed.
 *   3. Staleness — rows whose verification/as-of column is null or older than
 *      the threshold. The column differs per table and is named in the output,
 *      because only vehicle_variants has a `last_verified_at`.
 *   4. Reference key coverage — "every state has a petrol price" is a more
 *      useful question about a reference table than "how many nulls".
 *   5. Anomalies — chiefly `claimed_*` present while `real_world_*` is missing,
 *      which is the exact failure the never-calculate-from-claimed rule guards.
 *
 * THE EMPTY-DATABASE PROBLEM, DECIDED DELIBERATELY
 *   The catalogue is seeded incrementally. A naive threshold gate would make
 *   this command exit non-zero on a correctly migrated, correctly seeded
 *   database on day one, which trains everyone to ignore it. So a curated table
 *   with zero rows is reported prominently as UNPOPULATED, excluded from the
 *   coverage averages, and is NOT a failure unless --strict. Percentages are
 *   computed only over populated tables, so the gate goes red the moment the
 *   catalogue lands half-sourced — which is the state that actually matters.
 *
 * EXIT CODES
 *   0  pass
 *   1  a gate failed (coverage below threshold, orphaned provenance, anomaly)
 *   2  usage error                               (matches scripts/seed.mts)
 *   3  environment problem — DATABASE_URL unset, database unreachable, or the
 *      schema is not migrated. Kept distinct from 1 so CI can tell "the data is
 *      thin" from "the infrastructure broke".
 *
 * TWO MECHANICAL CONSTRAINTS, BOTH LOAD-BEARING
 *   - This file must stay `.ts`, not `.mts`. The package has no "type":
 *     "module", so tsx compiles it as CommonJS, and `import * as schema from
 *     "../src/db/schema"` then resolves all 38 tables. From an ESM entry the
 *     same import yields only `default` — the `export *` gotcha in CLAUDE.md.
 *     The price is that top-level `await` is a hard error here, hence
 *     `async function main()` plus an explicit `.then`.
 *   - `column.name` returns the camelCase TS property, not the SQL name,
 *     because `casing: "snake_case"` lives on drizzle() rather than on the
 *     column. Every SQL identifier here goes through `toSnakeCase`.
 *
 * CAVEAT: package.json runs this under `node --env-file=.env.local`, which
 * hard-errors before this file executes if `.env.local` is absent. On a fresh
 * clone run `vercel env pull .env.local` first.
 */
import { getTableColumns, getTableName, is } from "drizzle-orm";
import { toSnakeCase } from "drizzle-orm/casing";
import { PgTable, type PgColumn } from "drizzle-orm/pg-core";
import postgres from "postgres";

import * as schema from "../src/db/schema";

// ---------------------------------------------------------------------------
// Spec — pure declarative data. Keyed by SQL table name so the drift test can
// assert every name here still exists in the Drizzle schema.
// ---------------------------------------------------------------------------

export type TableKind = "curated" | "reference" | "operational";

/** SQL predicates naming the population a conditional column applies to. */
const EV = `"fuel_type" in ('electric', 'plugin_hybrid')`;
const COMBUSTION = `"fuel_type" <> 'electric'`;
const LIQUID_TANK = `"fuel_type" in ('petrol', 'diesel', 'lpg', 'flex_fuel', 'hybrid_mild', 'hybrid_strong', 'plugin_hybrid')`;
const CNG = `"fuel_type" = 'cng'`;
const E20_APPLIES = `"verdict" in ('e20_compliant', 'e20_tolerant', 'e10_only')`;
const NOT_INFERRED = `"inferred_from_norm" = false`;

export type FieldSpec = {
  /** Drizzle property name. Converted to SQL with toSnakeCase. */
  field: string;
  /**
   * jsonb array columns are `.notNull().default([])`, so count(col) reports
   * them 100% complete while they hold `[]`. Measure length instead.
   */
  kind?: "scalar" | "jsonbArray";
  /** Counts toward the gated critical-completeness figure. */
  critical?: boolean;
  /** Expect a current fact_provenance row per populated value. */
  provenance?: boolean;
  /** Narrows the denominator to the rows the column is meaningful for. */
  appliesWhen?: string;
};

export type TableSpec = {
  table: string;
  kind: TableKind;
  fields?: readonly FieldSpec[];
  /** Columns kept for display only; reported, never scored. */
  displayOnly?: readonly string[];
  /** Column carrying "when was this last known good". Semantics differ; named in output. */
  stalenessColumn?: string;
  /** Per-table override of --stale-days. Fuel prices rot in weeks; resale curves do not. */
  stalenessDays?: number;
  /** Inline attribution column, where a table carries its source directly. */
  sourceColumn?: string;
};

export const TABLE_SPECS: readonly TableSpec[] = [
  // --- curated -------------------------------------------------------------
  {
    table: "sources",
    kind: "curated",
    fields: [{ field: "homepageUrl" }, { field: "crawlNotes" }],
    stalenessColumn: "lastCheckedAt",
  },
  {
    table: "manufacturers",
    kind: "curated",
    fields: [
      { field: "serviceCentreCount", critical: true, provenance: true },
      { field: "country" },
      { field: "logoUrl" },
    ],
    stalenessColumn: "serviceCentreCountAsOf",
  },
  {
    table: "vehicle_models",
    kind: "curated",
    fields: [
      { field: "launchYear", provenance: true },
      { field: "summary" },
      { field: "imageUrl" },
      { field: "knownAdvantages", kind: "jsonbArray" },
      { field: "knownDisadvantages", kind: "jsonbArray" },
      { field: "commonProblems", kind: "jsonbArray" },
    ],
    // No last_verified_at on this table; updated_at is the honest proxy for
    // "nothing has touched this row in a long time".
    stalenessColumn: "updatedAt",
  },
  {
    table: "vehicle_variants",
    kind: "curated",
    fields: [
      // Every economics number is built on these. claimed_* is never one of them.
      { field: "exShowroomPaise", critical: true, provenance: true },
      { field: "realWorldEfficiencyCity", critical: true, provenance: true },
      { field: "realWorldEfficiencyHighway", critical: true, provenance: true },
      // A bare efficiency number is unusable without its unit — kmpl, km/kg, km/kWh.
      { field: "efficiencyUnit", critical: true },
      { field: "realWorldRangeKm", critical: true, provenance: true, appliesWhen: EV },
      { field: "seatingCapacity", critical: true, provenance: true },

      { field: "engineCc", provenance: true, appliesWhen: COMBUSTION },
      { field: "powerBhp", provenance: true },
      { field: "torqueNm", provenance: true },
      { field: "kerbWeightKg", provenance: true },
      { field: "bootLitres" },
      { field: "groundClearanceMm" },
      { field: "fuelTankLitres", provenance: true, appliesWhen: LIQUID_TANK },
      { field: "cngTankKg", provenance: true, appliesWhen: CNG },
      { field: "batteryKwh", provenance: true, appliesWhen: EV },
      { field: "batteryChemistry", provenance: true, appliesWhen: EV },
      { field: "dcChargeKw", appliesWhen: EV },
      { field: "dcChargeMinutes10To80", appliesWhen: EV },
      { field: "batteryWarrantyYears", appliesWhen: EV },
      { field: "payloadKg" },
      { field: "gvwKg" },
      { field: "scheduledServiceCost5yPaise", provenance: true },
    ],
    displayOnly: ["claimedEfficiency", "claimedRangeKm"],
    stalenessColumn: "lastVerifiedAt",
  },
  {
    table: "variant_availability",
    kind: "curated",
    fields: [{ field: "note" }],
  },
  {
    // The highest-liability table in the product. Nothing here without a source.
    table: "e20_compatibility",
    kind: "curated",
    fields: [
      { field: "sourceId", critical: true, appliesWhen: NOT_INFERRED },
      { field: "mileageDeltaMinPct", critical: true, provenance: true, appliesWhen: E20_APPLIES },
      { field: "mileageDeltaMaxPct", critical: true, provenance: true, appliesWhen: E20_APPLIES },
      { field: "oemStatementUrl", appliesWhen: NOT_INFERRED },
      { field: "oemStatementSummary", appliesWhen: NOT_INFERRED },
    ],
    stalenessColumn: "updatedAt",
  },
  {
    table: "e20_guidance_rules",
    kind: "curated",
    fields: [{ field: "sourceId", critical: true }, { field: "appliesToMaxYear" }],
  },
  {
    table: "e20_kb_chunks",
    kind: "curated",
    fields: [
      // Retrieval is lexical fused with vector; a null embedding halves recall.
      { field: "embedding", critical: true },
      { field: "sourceId", critical: true },
      { field: "embeddingModel" },
      { field: "sourceUrl" },
      { field: "publishedAt" },
      { field: "title" },
      { field: "tags", kind: "jsonbArray" },
    ],
    stalenessColumn: "embeddedAt",
  },

  // --- reference -----------------------------------------------------------
  { table: "states", kind: "reference", fields: [{ field: "region" }] },
  {
    table: "cities",
    kind: "reference",
    fields: [
      { field: "population" },
      { field: "tier" },
      { field: "latitude" },
      { field: "longitude" },
    ],
  },
  {
    // effective_from is deliberately NOT a staleness column: a 2019 road-tax
    // rule that is still in force is current, not stale.
    table: "state_on_road_factors",
    kind: "reference",
    fields: [{ field: "notes" }],
  },
  {
    table: "fuel_prices",
    kind: "reference",
    sourceColumn: "sourceId",
    stalenessColumn: "asOf",
    stalenessDays: 30,
  },
  { table: "electricity_tariffs", kind: "reference", stalenessColumn: "asOf", stalenessDays: 365 },
  {
    table: "maintenance_curves",
    kind: "reference",
    sourceColumn: "sourceId",
    stalenessColumn: "asOf",
    stalenessDays: 365,
  },
  {
    table: "resale_curves",
    kind: "reference",
    fields: [{ field: "liquidityScore" }],
    sourceColumn: "sourceId",
    stalenessColumn: "asOf",
    stalenessDays: 365,
  },
  {
    table: "battery_costs",
    kind: "reference",
    sourceColumn: "sourceId",
    stalenessColumn: "asOf",
    stalenessDays: 365,
  },
  { table: "finance_rates", kind: "reference", stalenessColumn: "asOf", stalenessDays: 90 },
  {
    table: "emission_factors",
    kind: "reference",
    sourceColumn: "sourceId",
    stalenessColumn: "asOf",
    stalenessDays: 365,
  },
  {
    table: "fuel_stations",
    kind: "reference",
    fields: [
      { field: "stateCode" },
      { field: "cityId" },
      { field: "latitude" },
      { field: "longitude" },
      { field: "chargerCount" },
      { field: "maxKw" },
    ],
    sourceColumn: "sourceId",
    stalenessColumn: "lastSeenAt",
    stalenessDays: 365,
  },
  {
    table: "infra_density",
    kind: "reference",
    fields: [
      { field: "perLakhPopulation" },
      { field: "percentile" },
      { field: "medianDistanceKm" },
    ],
    stalenessColumn: "asOf",
    stalenessDays: 365,
  },

  // --- operational: row counts only, never gated ---------------------------
  { table: "users", kind: "operational" },
  { table: "sessions", kind: "operational" },
  { table: "otp_codes", kind: "operational" },
  { table: "recommendation_runs", kind: "operational" },
  { table: "e20_assessments", kind: "operational" },
  { table: "saved_vehicles", kind: "operational" },
  { table: "reports", kind: "operational" },
  { table: "feedback", kind: "operational" },
  { table: "llm_calls", kind: "operational" },
  { table: "scrape_jobs", kind: "operational" },
  { table: "raw_documents", kind: "operational" },
  { table: "staging_records", kind: "operational" },
  { table: "review_queue", kind: "operational" },
  { table: "data_change_log", kind: "operational" },
  { table: "audit_log", kind: "operational" },
  { table: "economics_refresh_log", kind: "operational" },
  { table: "fact_provenance", kind: "operational" },
  { table: "data_quality", kind: "operational" },
];

/**
 * Reference-table health is a key-coverage question, not a null-count question:
 * "is there a petrol price for every state" is what breaks a recommendation.
 * Each check returns covered/total; `critical` ones feed the gate.
 */
export type CoverageCheck = {
  name: string;
  critical: boolean;
  /** Tables that must exist in the database for the query to run at all. */
  requires: readonly string[];
  /**
   * The tables supplying the numerator. If any is empty the check is reported
   * as unpopulated rather than as 0% — same policy as an empty curated table,
   * and for the same reason: seeding is incremental, and a gate that is red on
   * a correctly seeded database is a gate everyone learns to ignore.
   */
  measures: readonly string[];
  sql: string;
};

export const COVERAGE_CHECKS: readonly CoverageCheck[] = [
  {
    name: "states with on-road factors",
    critical: true,
    requires: ["states", "state_on_road_factors"],
    measures: ["state_on_road_factors"],
    sql: `select (select count(*) from "states")::int as total,
                 (select count(distinct "state_code") from "state_on_road_factors")::int as covered`,
  },
  {
    name: "states with a petrol price",
    critical: true,
    requires: ["states", "fuel_prices"],
    measures: ["fuel_prices"],
    sql: `select (select count(*) from "states")::int as total,
                 (select count(distinct "state_code") from "fuel_prices" where "fuel_type" = 'petrol')::int as covered`,
  },
  {
    name: "states with a diesel price",
    critical: true,
    requires: ["states", "fuel_prices"],
    measures: ["fuel_prices"],
    sql: `select (select count(*) from "states")::int as total,
                 (select count(distinct "state_code") from "fuel_prices" where "fuel_type" = 'diesel')::int as covered`,
  },
  {
    name: "states with an electricity tariff",
    critical: true,
    requires: ["states", "electricity_tariffs"],
    measures: ["electricity_tariffs"],
    sql: `select (select count(*) from "states")::int as total,
                 (select count(distinct "state_code") from "electricity_tariffs")::int as covered`,
  },
  {
    name: "models with at least one variant",
    critical: true,
    requires: ["vehicle_models", "vehicle_variants"],
    measures: ["vehicle_variants"],
    sql: `select (select count(*) from "vehicle_models")::int as total,
                 (select count(distinct "model_id") from "vehicle_variants")::int as covered`,
  },
  {
    name: "segment x fuel pairs with a maintenance curve",
    critical: true,
    requires: ["vehicle_models", "vehicle_variants", "maintenance_curves"],
    measures: ["maintenance_curves"],
    sql: `with pairs as (
            select distinct m."segment", v."fuel_type"
            from "vehicle_variants" v join "vehicle_models" m on m."id" = v."model_id"
            where v."status" = 'active'
          )
          select (select count(*) from pairs)::int as total,
                 (select count(*) from pairs p
                  where exists (select 1 from "maintenance_curves" c
                                where c."segment" = p."segment" and c."fuel_type" = p."fuel_type"))::int as covered`,
  },
  {
    name: "segment x fuel pairs with a resale curve",
    critical: true,
    requires: ["vehicle_models", "vehicle_variants", "resale_curves"],
    measures: ["resale_curves"],
    sql: `with pairs as (
            select distinct m."segment", v."fuel_type"
            from "vehicle_variants" v join "vehicle_models" m on m."id" = v."model_id"
            where v."status" = 'active'
          )
          select (select count(*) from pairs)::int as total,
                 (select count(*) from pairs p
                  where exists (select 1 from "resale_curves" c
                                where c."segment" = p."segment" and c."fuel_type" = p."fuel_type"))::int as covered`,
  },
  {
    name: "fuel types with an emission factor",
    critical: true,
    requires: ["vehicle_variants", "emission_factors"],
    measures: ["emission_factors"],
    sql: `select (select count(distinct "fuel_type") from "vehicle_variants" where "status" = 'active')::int as total,
                 (select count(distinct v."fuel_type") from "vehicle_variants" v
                  where v."status" = 'active'
                    and exists (select 1 from "emission_factors" e where e."fuel_type" = v."fuel_type"))::int as covered`,
  },
  {
    name: "EV chemistries with a battery cost",
    critical: false,
    requires: ["vehicle_variants", "battery_costs"],
    measures: ["battery_costs"],
    sql: `select (select count(distinct "battery_chemistry") from "vehicle_variants" where "battery_chemistry" is not null)::int as total,
                 (select count(distinct v."battery_chemistry") from "vehicle_variants" v
                  where v."battery_chemistry" is not null
                    and exists (select 1 from "battery_costs" b where b."chemistry" = v."battery_chemistry"))::int as covered`,
  },
  {
    name: "petrol variants with a settled E20 verdict",
    critical: true,
    requires: ["vehicle_variants"],
    measures: ["vehicle_variants"],
    sql: `select (select count(*) from "vehicle_variants"
                  where "fuel_type" in ('petrol', 'flex_fuel', 'hybrid_mild', 'hybrid_strong', 'plugin_hybrid'))::int as total,
                 (select count(*) from "vehicle_variants"
                  where "fuel_type" in ('petrol', 'flex_fuel', 'hybrid_mild', 'hybrid_strong', 'plugin_hybrid')
                    and "e20_verdict" <> 'unknown')::int as covered`,
  },
  {
    name: "e20_kb_chunks with an embedding",
    critical: false,
    requires: ["e20_kb_chunks"],
    measures: ["e20_kb_chunks"],
    sql: `select (select count(*) from "e20_kb_chunks")::int as total,
                 (select count("embedding") from "e20_kb_chunks")::int as covered`,
  },
];

// ---------------------------------------------------------------------------
// Argument parsing (mirrors scripts/seed.mts)
// ---------------------------------------------------------------------------

export type Args = {
  only: string[];
  json: boolean;
  strict: boolean;
  list: boolean;
  help: boolean;
  minCoverage: number;
  minProvenance: number;
  staleDays: number;
  maxStalePct: number | null;
};

export const DEFAULT_ARGS: Args = {
  only: [],
  json: false,
  strict: false,
  list: false,
  help: false,
  minCoverage: 90,
  minProvenance: 90,
  staleDays: 180,
  maxStalePct: null,
};

function parseNumberFlag(raw: string, flag: string, min: number, max: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${flag} expects a number between ${min} and ${max}, got: ${raw}`);
  }
  return value;
}

export function parseArgs(argv: readonly string[]): Args {
  const args: Args = { ...DEFAULT_ARGS, only: [] };
  for (const arg of argv) {
    if (arg === "--json") args.json = true;
    else if (arg === "--strict") args.strict = true;
    else if (arg === "--list") args.list = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg.startsWith("--only=")) {
      args.only.push(
        ...arg
          .slice("--only=".length)
          .split(",")
          .map((name) => name.trim())
          .filter((name) => name.length > 0),
      );
    } else if (arg.startsWith("--min-coverage=")) {
      args.minCoverage = parseNumberFlag(arg.slice("--min-coverage=".length), "--min-coverage", 0, 100);
    } else if (arg.startsWith("--min-provenance=")) {
      args.minProvenance = parseNumberFlag(
        arg.slice("--min-provenance=".length),
        "--min-provenance",
        0,
        100,
      );
    } else if (arg.startsWith("--stale-days=")) {
      args.staleDays = parseNumberFlag(arg.slice("--stale-days=".length), "--stale-days", 1, 36500);
    } else if (arg.startsWith("--max-stale-pct=")) {
      args.maxStalePct = parseNumberFlag(
        arg.slice("--max-stale-pct=".length),
        "--max-stale-pct",
        0,
        100,
      );
    } else {
      throw new Error(`Unrecognised argument: ${arg}`);
    }
  }

  const known = new Set(TABLE_SPECS.map((spec) => spec.table));
  const unknown = args.only.filter((name) => !known.has(name));
  if (unknown.length > 0) {
    throw new Error(`Unknown table(s) in --only: ${unknown.join(", ")}`);
  }
  return args;
}

export const USAGE = `Usage: pnpm db:validate [--json] [--only=a,b] [--list] [--strict]
                        [--min-coverage=90] [--min-provenance=90]
                        [--stale-days=180] [--max-stale-pct=N]

Exit codes: 0 pass · 1 gate failed · 2 usage error · 3 environment/connection.`;

// ---------------------------------------------------------------------------
// Pure query construction
// ---------------------------------------------------------------------------

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/** Every identifier is schema-derived, never user input — but assert it anyway. */
export function ident(name: string): string {
  if (!IDENTIFIER.test(name)) throw new Error(`Refusing to build SQL with identifier: ${name}`);
  return `"${name}"`;
}

export type ResolvedField = FieldSpec & { column: string };

/**
 * Resolve spec field names to SQL column names, dropping anything the schema no
 * longer has. Returns the drops so the caller can report drift rather than
 * silently under-reporting.
 */
export function resolveFields(
  columnsByProperty: Readonly<Record<string, unknown>>,
  fields: readonly FieldSpec[],
): { resolved: ResolvedField[]; missing: string[] } {
  const resolved: ResolvedField[] = [];
  const missing: string[] = [];
  for (const field of fields) {
    if (!(field.field in columnsByProperty)) {
      missing.push(field.field);
      continue;
    }
    resolved.push({ ...field, column: toSnakeCase(field.field) });
  }
  return { resolved, missing };
}

/**
 * One round trip per table. Emits `__n__<col>` (the applicable denominator) and
 * `<col>` (populated within it) so a conditional column is never scored against
 * rows it does not apply to.
 *
 * count() is always cast to ::int — postgres.js returns an uncast count as a
 * string, which coerces silently and then concatenates instead of adding.
 */
export function buildCompletenessQuery(table: string, fields: readonly ResolvedField[]): string {
  const parts = [`count(*)::int as "__total"`];
  for (const field of fields) {
    const col = ident(field.column);
    const applies = field.appliesWhen;
    const present =
      field.kind === "jsonbArray"
        ? `jsonb_array_length(${col}) > 0`
        : `${col} is not null`;
    const presentWhere = applies ? `(${applies}) and ${present}` : present;
    parts.push(`(count(*) filter (where ${presentWhere}))::int as ${ident(field.column)}`);
    parts.push(
      `(count(*) filter (where ${applies ?? "true"}))::int as ${ident(`__n__${field.column}`)}`,
    );
  }
  return `select ${parts.join(", ")} from "public".${ident(table)}`;
}

export function buildStalenessQuery(table: string, column: string, days: number): string {
  if (!Number.isInteger(days) || days <= 0) throw new Error(`stale-days must be a positive integer`);
  // A `date` column compares against timestamptz via implicit cast, so one
  // form covers both the `as_of` dates and the `*_at` timestamps.
  return `select (count(*) filter (where ${ident(column)} is null
            or ${ident(column)} < now() - make_interval(days => ${days})))::int as "stale",
            count(*)::int as "total" from "public".${ident(table)}`;
}

// ---------------------------------------------------------------------------
// Findings and scoring — pure
// ---------------------------------------------------------------------------

export type ColumnCompleteness = {
  property: string;
  column: string;
  critical: boolean;
  present: number;
  applicable: number;
};

export type ProvenanceCoverage = { column: string; covered: number; expected: number };

export type TableFinding = {
  table: string;
  kind: TableKind;
  exists: boolean;
  rowCount: number;
  columns: ColumnCompleteness[];
  displayOnly: ColumnCompleteness[];
  provenance: ProvenanceCoverage[];
  /** Which spelling fact_provenance.field actually uses, so 0% is never a mystery. */
  provenanceFieldForms: { snake: number; camel: number };
  orphanProvenance: number | null;
  staleness: { column: string; days: number; stale: number; total: number } | null;
  sourceAttribution: { column: string; attributed: number; total: number } | null;
  anomalies: string[];
  /** Spec'd columns the live schema no longer has. */
  schemaDrift: string[];
};

export type SkipReason = "not-migrated" | "not-selected" | "unpopulated";

export type CheckFinding = {
  name: string;
  critical: boolean;
  covered: number;
  total: number;
  /** false when the check ran; otherwise why it did not count. */
  skipped: false | SkipReason;
};

export type Thresholds = {
  minCoverage: number;
  minProvenance: number;
  staleDays: number;
  maxStalePct: number | null;
  strict: boolean;
};

export type CoverageResult = {
  tables: TableFinding[];
  checks: CheckFinding[];
  missingTables: string[];
  unpopulatedCurated: string[];
  unpopulatedChecks: string[];
  criticalPresent: number;
  criticalApplicable: number;
  criticalPct: number | null;
  overallPresent: number;
  overallApplicable: number;
  overallPct: number | null;
  provenanceCovered: number;
  provenanceExpected: number;
  provenancePct: number | null;
  checkCovered: number;
  checkTotal: number;
  checkPct: number | null;
  orphanProvenanceTotal: number;
  staleRows: number;
  staleTotal: number;
  stalePct: number | null;
  anomalies: string[];
  schemaDrift: string[];
  thresholds: Thresholds;
  failures: string[];
  passed: boolean;
};

/** Null denominator means "not applicable", which is different from zero. */
export function pct(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return (numerator / denominator) * 100;
}

export function isPopulated(finding: TableFinding): boolean {
  return finding.exists && finding.rowCount > 0;
}

export function computeCoverage(
  tables: readonly TableFinding[],
  checks: readonly CheckFinding[],
  thresholds: Thresholds,
): CoverageResult {
  let criticalPresent = 0;
  let criticalApplicable = 0;
  let overallPresent = 0;
  let overallApplicable = 0;
  let provenanceCovered = 0;
  let provenanceExpected = 0;
  let orphanProvenanceTotal = 0;
  let staleRows = 0;
  let staleTotal = 0;

  const missingTables: string[] = [];
  const unpopulatedCurated: string[] = [];
  const anomalies: string[] = [];
  const schemaDrift: string[] = [];

  for (const finding of tables) {
    for (const column of finding.schemaDrift) {
      schemaDrift.push(`${finding.table}.${column}`);
    }
    if (!finding.exists) {
      missingTables.push(finding.table);
      continue;
    }
    for (const anomaly of finding.anomalies) anomalies.push(`${finding.table}: ${anomaly}`);
    orphanProvenanceTotal += finding.orphanProvenance ?? 0;

    if (finding.rowCount === 0) {
      // Unpopulated: reported, excluded from every average. See the header.
      if (finding.kind === "curated") unpopulatedCurated.push(finding.table);
      continue;
    }

    for (const column of finding.columns) {
      overallPresent += column.present;
      overallApplicable += column.applicable;
      if (column.critical) {
        criticalPresent += column.present;
        criticalApplicable += column.applicable;
      }
    }
    for (const entry of finding.provenance) {
      // Clamp: a stale/orphaned provenance row must not inflate coverage above
      // the number of facts that actually exist. Orphans are reported separately.
      provenanceCovered += Math.min(entry.covered, entry.expected);
      provenanceExpected += entry.expected;
    }
    if (finding.staleness) {
      staleRows += finding.staleness.stale;
      staleTotal += finding.staleness.total;
    }
  }

  let checkCovered = 0;
  let checkTotal = 0;
  const unpopulatedChecks: string[] = [];
  for (const check of checks) {
    if (check.skipped === "unpopulated") unpopulatedChecks.push(check.name);
    if (check.skipped) continue;
    checkCovered += check.covered;
    checkTotal += check.total;
  }

  const criticalPct = pct(criticalPresent, criticalApplicable);
  const overallPct = pct(overallPresent, overallApplicable);
  const provenancePct = pct(provenanceCovered, provenanceExpected);
  const checkPct = pct(checkCovered, checkTotal);
  const stalePct = pct(staleRows, staleTotal);

  const failures: string[] = [];
  if (missingTables.length > 0) {
    failures.push(
      `${missingTables.length} table(s) missing from the database: ${missingTables.join(", ")} — run pnpm db:migrate`,
    );
  }
  if (schemaDrift.length > 0) {
    failures.push(`validation spec references columns that no longer exist: ${schemaDrift.join(", ")}`);
  }
  if (criticalPct !== null && criticalPct < thresholds.minCoverage) {
    failures.push(
      `critical completeness ${criticalPct.toFixed(1)}% is below the ${thresholds.minCoverage}% threshold`,
    );
  }
  if (provenancePct !== null && provenancePct < thresholds.minProvenance) {
    failures.push(
      `provenance coverage ${provenancePct.toFixed(1)}% is below the ${thresholds.minProvenance}% threshold`,
    );
  }
  for (const check of checks) {
    if (check.skipped || !check.critical) continue;
    const value = pct(check.covered, check.total);
    if (value !== null && value < thresholds.minCoverage) {
      failures.push(
        `coverage check "${check.name}" at ${value.toFixed(1)}% (${check.covered}/${check.total}) is below the ${thresholds.minCoverage}% threshold`,
      );
    }
  }
  if (orphanProvenanceTotal > 0) {
    failures.push(
      `${orphanProvenanceTotal} fact_provenance row(s) point at an entity_id that no longer exists`,
    );
  }
  for (const anomaly of anomalies) failures.push(anomaly);
  if (
    thresholds.maxStalePct !== null &&
    stalePct !== null &&
    stalePct > thresholds.maxStalePct
  ) {
    failures.push(
      `${stalePct.toFixed(1)}% of rows are stale, above the ${thresholds.maxStalePct}% ceiling`,
    );
  }
  if (thresholds.strict && unpopulatedCurated.length > 0) {
    failures.push(`--strict: curated table(s) are empty: ${unpopulatedCurated.join(", ")}`);
  }
  if (thresholds.strict && unpopulatedChecks.length > 0) {
    failures.push(
      `--strict: coverage check(s) have nothing to measure: ${unpopulatedChecks.join(", ")}`,
    );
  }

  return {
    tables: [...tables],
    checks: [...checks],
    missingTables,
    unpopulatedCurated,
    unpopulatedChecks,
    criticalPresent,
    criticalApplicable,
    criticalPct,
    overallPresent,
    overallApplicable,
    overallPct,
    provenanceCovered,
    provenanceExpected,
    provenancePct,
    checkCovered,
    checkTotal,
    checkPct,
    orphanProvenanceTotal,
    staleRows,
    staleTotal,
    stalePct,
    anomalies,
    schemaDrift,
    thresholds,
    failures,
    passed: failures.length === 0,
  };
}

export function exitCodeFor(result: CoverageResult): 0 | 1 {
  return result.passed ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Formatting — pure
// ---------------------------------------------------------------------------

export function formatPct(value: number | null): string {
  return value === null ? "n/a" : `${value.toFixed(1)}%`;
}

function pad(label: string, width = 22): string {
  return `${label}:`.padEnd(width);
}

export function formatReport(result: CoverageResult, database: string): string {
  const t = result.thresholds;
  const lines: string[] = [];

  lines.push(`Carbon Miles — data validation`);
  lines.push(`${pad("database")}${database}`);
  lines.push(
    `${pad("thresholds")}critical >= ${t.minCoverage}%, provenance >= ${t.minProvenance}%, stale after ${t.staleDays}d${t.strict ? ", strict" : ""}`,
  );

  lines.push(``, `TABLES`);
  for (const finding of result.tables) {
    if (!finding.exists) {
      lines.push(`  ${finding.table.padEnd(24)}${finding.kind.padEnd(13)}MISSING FROM DATABASE`);
      continue;
    }
    const head = `  ${finding.table.padEnd(24)}${finding.kind.padEnd(13)}${String(finding.rowCount).padStart(7)} rows`;
    if (finding.rowCount === 0) {
      lines.push(`${head}  ${finding.kind === "curated" ? "UNPOPULATED" : "empty"}`);
      continue;
    }
    const present = finding.columns.reduce((sum, c) => sum + c.present, 0);
    const applicable = finding.columns.reduce((sum, c) => sum + c.applicable, 0);
    const provCovered = finding.provenance.reduce((s, p) => s + Math.min(p.covered, p.expected), 0);
    const provExpected = finding.provenance.reduce((s, p) => s + p.expected, 0);
    const stale = finding.staleness
      ? `stale ${formatPct(pct(finding.staleness.stale, finding.staleness.total))} (${finding.staleness.column} > ${finding.staleness.days}d)`
      : `stale n/a`;
    lines.push(
      `${head}  complete ${formatPct(pct(present, applicable))}  provenance ${formatPct(pct(provCovered, provExpected))}  ${stale}`,
    );

    // Only spell out the columns that are actually short.
    for (const column of finding.columns) {
      const value = pct(column.present, column.applicable);
      if (value === null || value >= 100) continue;
      lines.push(
        `      ${column.critical ? "!" : " "} ${column.column.padEnd(32)}${String(column.present).padStart(7)}/${String(column.applicable).padEnd(8)}${formatPct(value)}`,
      );
    }
    for (const column of finding.displayOnly) {
      lines.push(
        `      ~ ${`${column.column} (display only)`.padEnd(32)}${String(column.present).padStart(7)}/${String(column.applicable).padEnd(8)}${formatPct(pct(column.present, column.applicable))}`,
      );
    }
    if (finding.sourceAttribution) {
      const s = finding.sourceAttribution;
      lines.push(
        `      · ${`${s.column} attribution`.padEnd(32)}${String(s.attributed).padStart(7)}/${String(s.total).padEnd(8)}${formatPct(pct(s.attributed, s.total))}`,
      );
    }
    if (finding.orphanProvenance) {
      lines.push(`      x orphaned provenance rows: ${finding.orphanProvenance}`);
    }
    const forms = finding.provenanceFieldForms;
    if (forms.camel > 0) {
      lines.push(
        `      x fact_provenance.field uses camelCase for ${forms.camel} row(s)` +
          (forms.snake > 0 ? ` and snake_case for ${forms.snake} — the two cannot be joined` : ``),
      );
    }
  }

  lines.push(``, `COVERAGE CHECKS`);
  for (const check of result.checks) {
    if (check.skipped) {
      const reason: Record<SkipReason, string> = {
        "not-migrated": "skipped (table not migrated)",
        "not-selected": "skipped (outside --only)",
        unpopulated: "UNPOPULATED",
      };
      lines.push(`  ${check.name.padEnd(46)}${reason[check.skipped]}`);
      continue;
    }
    const value = pct(check.covered, check.total);
    lines.push(
      `  ${check.name.padEnd(46)}${String(check.covered).padStart(6)}/${String(check.total).padEnd(7)}${formatPct(value).padStart(7)}${check.critical ? "  [critical]" : ""}`,
    );
  }

  lines.push(``, `SUMMARY`);
  lines.push(
    `${pad("critical fields")}${formatPct(result.criticalPct)} (${result.criticalPresent}/${result.criticalApplicable})`,
  );
  lines.push(
    `${pad("all fields")}${formatPct(result.overallPct)} (${result.overallPresent}/${result.overallApplicable})`,
  );
  lines.push(
    `${pad("provenance")}${formatPct(result.provenancePct)} (${result.provenanceCovered}/${result.provenanceExpected})`,
  );
  lines.push(
    `${pad("reference coverage")}${formatPct(result.checkPct)} (${result.checkCovered}/${result.checkTotal})`,
  );
  lines.push(
    `${pad("stale rows")}${formatPct(result.stalePct)} (${result.staleRows}/${result.staleTotal})`,
  );
  lines.push(`${pad("orphaned provenance")}${result.orphanProvenanceTotal}`);
  lines.push(
    `${pad("unpopulated curated")}${result.unpopulatedCurated.length}${result.unpopulatedCurated.length > 0 ? ` (${result.unpopulatedCurated.join(", ")})` : ""}`,
  );

  if (result.failures.length > 0) {
    lines.push(``, `FAILURES`);
    for (const failure of result.failures) lines.push(`  - ${failure}`);
  }

  lines.push(``, `${pad("result")}${result.passed ? "PASS" : "FAIL"}`);
  if (result.unpopulatedCurated.length > 0 || result.unpopulatedChecks.length > 0) {
    lines.push(
      `Nothing to score yet — the fact tables are empty, so the thresholds are vacuous.`,
      `Re-run once \`pnpm db:seed\` has landed the catalogue; the gate bites from the first row.`,
    );
  }
  return lines.join("\n");
}

export function formatJson(result: CoverageResult, database: string): unknown {
  return {
    database,
    generatedAt: new Date().toISOString(),
    thresholds: result.thresholds,
    summary: {
      criticalPct: result.criticalPct,
      criticalPresent: result.criticalPresent,
      criticalApplicable: result.criticalApplicable,
      overallPct: result.overallPct,
      provenancePct: result.provenancePct,
      referenceCoveragePct: result.checkPct,
      stalePct: result.stalePct,
      orphanProvenance: result.orphanProvenanceTotal,
      unpopulatedCurated: result.unpopulatedCurated,
      unpopulatedChecks: result.unpopulatedChecks,
      missingTables: result.missingTables,
      schemaDrift: result.schemaDrift,
    },
    tables: result.tables,
    checks: result.checks,
    failures: result.failures,
    passed: result.passed,
  };
}

// ---------------------------------------------------------------------------
// Diagnostics — a driver stack trace is never the output
// ---------------------------------------------------------------------------

const ENVIRONMENT_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ECONNRESET",
  "EPIPE",
  "CONNECT_TIMEOUT",
  "CONNECTION_CLOSED",
  "CONNECTION_DESTROYED",
  "CONNECTION_ENDED",
  "28P01", // invalid_password
  "28000", // invalid_authorization_specification
  "3D000", // invalid_catalog_name
  "42P01", // undefined_table
  "42501", // insufficient_privilege
]);

/** postgres.js throws plain Errors for socket failures, so read `code` defensively. */
export function diagnose(error: unknown): { code: 0 | 1 | 3; message: string } {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";
  const detail = error instanceof Error ? error.message : String(error);

  if (code === "42P01") {
    return {
      code: 3,
      message: `The schema is not migrated (${detail}). Run \`pnpm db:migrate\`.`,
    };
  }
  if (code === "28P01" || code === "28000") {
    return { code: 3, message: `Database rejected the credentials in DATABASE_URL (${code}).` };
  }
  if (code === "3D000") {
    return { code: 3, message: `The database named in DATABASE_URL does not exist (${code}).` };
  }
  if (ENVIRONMENT_CODES.has(code)) {
    return {
      code: 3,
      message: `Cannot reach the database (${code}). Check DATABASE_URL in .env.local, or run \`vercel env pull .env.local\`.`,
    };
  }
  return { code: 1, message: `Validation failed: ${detail}` };
}

/** Host and database only — never echo credentials into a log. */
export function describeDatabase(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

// ---------------------------------------------------------------------------
// IO
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
type Sql = ReturnType<typeof postgres>;

function num(value: unknown): number {
  // ::int casts arrive as numbers; belt and braces for anything that does not.
  return typeof value === "number" ? value : Number(value ?? 0);
}

/** Pure: reads the Drizzle schema module, never the database. */
export function discoverTables(): Map<string, PgTable> {
  const found = new Map<string, PgTable>();
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) found.set(getTableName(value), value);
  }
  return found;
}

async function existingTableNames(sql: Sql): Promise<Set<string>> {
  const rows = (await sql`
    select table_name from information_schema.tables where table_schema = 'public'
  `) as unknown as Array<{ table_name: string }>;
  return new Set(rows.map((row) => row.table_name));
}

async function loadProvenance(
  sql: Sql,
  table: string,
): Promise<Map<string, number>> {
  const rows = (await sql`
    select field, count(*)::int as n
    from fact_provenance
    where entity_table = ${table} and superseded_at is null
    group by field
  `) as unknown as Array<{ field: string; n: number }>;
  return new Map(rows.map((row) => [row.field, num(row.n)]));
}

async function inspectTable(
  sql: Sql,
  spec: TableSpec,
  table: PgTable,
  exists: boolean,
  staleDays: number,
): Promise<TableFinding> {
  const columnsByProperty = getTableColumns(table) as unknown as Record<string, PgColumn>;
  const specFields = spec.fields ?? [];
  const { resolved, missing } = resolveFields(columnsByProperty, specFields);
  const displaySpecs = (spec.displayOnly ?? []).map((field) => ({ field }));
  const display = resolveFields(columnsByProperty, displaySpecs);

  const empty: TableFinding = {
    table: spec.table,
    kind: spec.kind,
    exists,
    rowCount: 0,
    columns: [],
    displayOnly: [],
    provenance: [],
    provenanceFieldForms: { snake: 0, camel: 0 },
    orphanProvenance: null,
    staleness: null,
    sourceAttribution: null,
    anomalies: [],
    schemaDrift: [...missing, ...display.missing],
  };
  if (!exists) return empty;

  const all = [...resolved, ...display.resolved];
  const row = (
    (await sql.unsafe(buildCompletenessQuery(spec.table, all))) as unknown as Row[]
  )[0];
  const rowCount = num(row?.__total);

  const toCompleteness = (field: ResolvedField): ColumnCompleteness => ({
    property: field.field,
    column: field.column,
    critical: field.critical === true,
    present: num(row?.[field.column]),
    applicable: num(row?.[`__n__${field.column}`]),
  });

  const finding: TableFinding = {
    ...empty,
    rowCount,
    columns: resolved.map(toCompleteness),
    displayOnly: display.resolved.map(toCompleteness),
  };

  if (rowCount === 0) return finding;

  // --- provenance. Only tables with a uuid `id` can be referenced, because
  // fact_provenance.entity_id is `uuid not null` — states (text PK) cannot.
  const idColumn = columnsByProperty.id;
  const provenanceBearing = idColumn !== undefined && idColumn.columnType === "PgUUID";
  const wantsProvenance = resolved.filter((field) => field.provenance === true);
  if (provenanceBearing && wantsProvenance.length > 0) {
    const byField = await loadProvenance(sql, spec.table);
    let snake = 0;
    let camel = 0;
    finding.provenance = wantsProvenance.map((field) => {
      // The convention is snake_case, matching entity_table holding the SQL
      // table name. Count the camelCase spelling too rather than silently
      // reporting 0% if a writer ever regresses to `column.name`.
      const snakeHits = byField.get(field.column) ?? 0;
      const camelHits = field.field === field.column ? 0 : (byField.get(field.field) ?? 0);
      snake += snakeHits;
      camel += camelHits;
      const populated = num(row?.[field.column]);
      return { column: field.column, covered: snakeHits + camelHits, expected: populated };
    });
    finding.provenanceFieldForms = { snake, camel };

    const orphans = (await sql.unsafe(
      `select count(*)::int as n
         from "public"."fact_provenance" p
         left join "public".${ident(spec.table)} t on t."id" = p."entity_id"
        where p."entity_table" = $1 and t."id" is null`,
      [spec.table],
    )) as unknown as Array<{ n: number }>;
    finding.orphanProvenance = num(orphans[0]?.n);
  }

  // --- staleness
  if (spec.stalenessColumn) {
    const column = toSnakeCase(spec.stalenessColumn);
    if (spec.stalenessColumn in columnsByProperty) {
      const days = spec.stalenessDays ?? staleDays;
      const stale = (await sql.unsafe(
        buildStalenessQuery(spec.table, column, Math.trunc(days)),
      )) as unknown as Array<{ stale: number; total: number }>;
      finding.staleness = {
        column,
        days: Math.trunc(days),
        stale: num(stale[0]?.stale),
        total: num(stale[0]?.total),
      };
    } else {
      finding.schemaDrift = [...finding.schemaDrift, spec.stalenessColumn];
    }
  }

  // --- inline source attribution
  if (spec.sourceColumn && spec.sourceColumn in columnsByProperty) {
    const column = toSnakeCase(spec.sourceColumn);
    const attributed = (await sql.unsafe(
      `select (count(${ident(column)}))::int as n, count(*)::int as total from "public".${ident(spec.table)}`,
    )) as unknown as Array<{ n: number; total: number }>;
    finding.sourceAttribution = {
      column,
      attributed: num(attributed[0]?.n),
      total: num(attributed[0]?.total),
    };
  }

  // --- the convention this project cares about most
  if (spec.table === "vehicle_variants") {
    const anomaly = (await sql.unsafe(
      `select (count(*) filter (where "claimed_efficiency" is not null
                                  and "real_world_efficiency_city" is null))::int as eff,
              (count(*) filter (where "claimed_range_km" is not null
                                  and "real_world_range_km" is null))::int as range
         from "public"."vehicle_variants"`,
    )) as unknown as Array<{ eff: number; range: number }>;
    const eff = num(anomaly[0]?.eff);
    const range = num(anomaly[0]?.range);
    if (eff > 0) {
      finding.anomalies.push(
        `${eff} variant(s) have claimed_efficiency but no real_world_efficiency_city — every calculation must use the real-world figure`,
      );
    }
    if (range > 0) {
      finding.anomalies.push(
        `${range} variant(s) have claimed_range_km but no real_world_range_km — every calculation must use the real-world figure`,
      );
    }
  }

  return finding;
}

async function runCheck(
  sql: Sql,
  check: CoverageCheck,
  live: ReadonlySet<string>,
  selected: ReadonlySet<string>,
  rowCount: (table: string) => Promise<number>,
): Promise<CheckFinding> {
  const base = { name: check.name, critical: check.critical, covered: 0, total: 0 };
  if (!check.requires.every((table) => live.has(table))) {
    return { ...base, skipped: "not-migrated" };
  }
  if (!check.requires.every((table) => selected.has(table))) {
    return { ...base, skipped: "not-selected" };
  }
  for (const table of check.measures) {
    if ((await rowCount(table)) === 0) return { ...base, skipped: "unpopulated" };
  }
  const rows = (await sql.unsafe(check.sql)) as unknown as Array<{
    covered: number;
    total: number;
  }>;
  return {
    ...base,
    covered: num(rows[0]?.covered),
    total: num(rows[0]?.total),
    skipped: false,
  };
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${(error as Error).message}\n${USAGE}`);
    return 2;
  }

  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  if (args.list) {
    console.log("Tables covered by the validation spec:\n");
    for (const spec of TABLE_SPECS) {
      const fields = spec.fields?.length ?? 0;
      const critical = spec.fields?.filter((f) => f.critical).length ?? 0;
      console.log(
        `  ${spec.table.padEnd(24)}${spec.kind.padEnd(13)}${String(fields).padStart(2)} fields, ${critical} critical`,
      );
    }
    return 0;
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    // Deliberately not `import { db } from "../src/db/client"` — that module
    // throws at import time, which is the stack trace this guard exists to avoid.
    console.error(
      "DATABASE_URL is not set. Run `vercel env pull .env.local` or add it to .env.local.",
    );
    return 3;
  }

  const database = describeDatabase(connectionString);
  const sql = postgres(connectionString, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    onnotice: () => {},
  });

  try {
    const drizzleTables = discoverTables();
    const live = await existingTableNames(sql);

    const selected =
      args.only.length > 0
        ? TABLE_SPECS.filter((spec) => args.only.includes(spec.table))
        : TABLE_SPECS;

    const findings: TableFinding[] = [];
    for (const spec of selected) {
      const table = drizzleTables.get(spec.table);
      if (!table) {
        // The spec names a table the Drizzle schema no longer defines.
        findings.push({
          table: spec.table,
          kind: spec.kind,
          exists: false,
          rowCount: 0,
          columns: [],
          displayOnly: [],
          provenance: [],
          provenanceFieldForms: { snake: 0, camel: 0 },
          orphanProvenance: null,
          staleness: null,
          sourceAttribution: null,
          anomalies: [],
          schemaDrift: [`${spec.table} (no such table in src/db/schema)`],
        });
        continue;
      }
      findings.push(
        await inspectTable(sql, spec, table, live.has(spec.table), Math.trunc(args.staleDays)),
      );
    }

    const selectedNames = new Set(selected.map((spec) => spec.table));

    // Reuse the counts we already have; only query for a table --only skipped.
    const counts = new Map(findings.map((finding) => [finding.table, finding.rowCount]));
    const rowCount = async (table: string): Promise<number> => {
      const known = counts.get(table);
      if (known !== undefined) return known;
      const rows = (await sql.unsafe(
        `select count(*)::int as n from "public".${ident(table)}`,
      )) as unknown as Array<{ n: number }>;
      const value = num(rows[0]?.n);
      counts.set(table, value);
      return value;
    };

    const checks: CheckFinding[] = [];
    for (const check of COVERAGE_CHECKS) {
      checks.push(await runCheck(sql, check, live, selectedNames, rowCount));
    }

    const result = computeCoverage(findings, checks, {
      minCoverage: args.minCoverage,
      minProvenance: args.minProvenance,
      staleDays: Math.trunc(args.staleDays),
      maxStalePct: args.maxStalePct,
      strict: args.strict,
    });

    if (args.json) {
      console.log(JSON.stringify(formatJson(result, database), null, 2));
    } else {
      console.log(formatReport(result, database));
    }
    return exitCodeFor(result);
  } catch (error) {
    const { code, message } = diagnose(error);
    console.error(message);
    return code;
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

/**
 * Guarded so vitest can import the pure functions above without running the
 * report. `require.main === module` is unavailable here (this file is CJS under
 * tsx but ESM under vitest), so compare argv instead.
 */
const invokedDirectly = (process.argv[1] ?? "").endsWith("validate-data.ts");
if (invokedDirectly) {
  void main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      const { code, message } = diagnose(error);
      console.error(message);
      process.exit(code === 0 ? 1 : code);
    },
  );
}
