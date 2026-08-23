/**
 * Tests for `pnpm db:validate`.
 *
 * Everything here is pure — no database. The judgement calls (what counts as
 * complete, when the gate goes red, what the denominator is for a column that
 * only applies to EVs) are unit-tested; the SQL those decisions produce is
 * asserted as text and was separately executed against Postgres.
 *
 * Lives under tests/ rather than beside the script because vitest.config.mts
 * collects `src/**` and `tests/**` only — a test under scripts/ is never run.
 */
import { getTableColumns, getTableName } from "drizzle-orm";
import { toSnakeCase } from "drizzle-orm/casing";
import { describe, expect, it } from "vitest";

import {
  COVERAGE_CHECKS,
  DEFAULT_ARGS,
  TABLE_SPECS,
  type CheckFinding,
  type CoverageResult,
  type TableFinding,
  type Thresholds,
  buildCompletenessQuery,
  buildStalenessQuery,
  computeCoverage,
  describeDatabase,
  diagnose,
  discoverTables,
  exitCodeFor,
  formatJson,
  formatReport,
  ident,
  parseArgs,
  pct,
  resolveFields,
} from "../scripts/validate-data";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const THRESHOLDS: Thresholds = {
  minCoverage: 90,
  minProvenance: 90,
  staleDays: 180,
  maxStalePct: null,
  strict: false,
};

function finding(over: Partial<TableFinding> = {}): TableFinding {
  return {
    table: "vehicle_variants",
    kind: "curated",
    exists: true,
    rowCount: 10,
    columns: [],
    displayOnly: [],
    provenance: [],
    provenanceFieldForms: { snake: 0, camel: 0 },
    orphanProvenance: 0,
    staleness: null,
    sourceAttribution: null,
    anomalies: [],
    schemaDrift: [],
    ...over,
  };
}

function column(
  name: string,
  present: number,
  applicable: number,
  critical = true,
): TableFinding["columns"][number] {
  return { property: name, column: name, critical, present, applicable };
}

function check(over: Partial<CheckFinding> = {}): CheckFinding {
  return { name: "a check", critical: true, covered: 10, total: 10, skipped: false, ...over };
}

function run(
  tables: readonly TableFinding[],
  checks: readonly CheckFinding[] = [],
  thresholds: Partial<Thresholds> = {},
): CoverageResult {
  return computeCoverage(tables, checks, { ...THRESHOLDS, ...thresholds });
}

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
  it("defaults to a 90% gate and a 180-day staleness window", () => {
    expect(parseArgs([])).toEqual(DEFAULT_ARGS);
  });

  it("reads every flag", () => {
    const args = parseArgs([
      "--json",
      "--strict",
      "--min-coverage=75",
      "--min-provenance=50",
      "--stale-days=30",
      "--max-stale-pct=10",
      "--only=cities, states ,",
    ]);
    expect(args.json).toBe(true);
    expect(args.strict).toBe(true);
    expect(args.minCoverage).toBe(75);
    expect(args.minProvenance).toBe(50);
    expect(args.staleDays).toBe(30);
    expect(args.maxStalePct).toBe(10);
    expect(args.only).toEqual(["cities", "states"]);
  });

  it("rejects an unrecognised argument, as seed.mts does", () => {
    expect(() => parseArgs(["--nope"])).toThrow(/Unrecognised argument: --nope/);
  });

  it("rejects a table name that is not in the spec, rather than silently reporting nothing", () => {
    expect(() => parseArgs(["--only=vehicle_variants,bogus"])).toThrow(/Unknown table\(s\).*bogus/);
  });

  it.each([
    ["--min-coverage=abc"],
    ["--min-coverage=-1"],
    ["--min-coverage=101"],
    ["--stale-days=0"],
    ["--stale-days=nope"],
    ["--max-stale-pct=200"],
  ])("rejects %s", (arg) => {
    expect(() => parseArgs([arg])).toThrow();
  });

  it("accepts the threshold boundaries", () => {
    expect(parseArgs(["--min-coverage=0"]).minCoverage).toBe(0);
    expect(parseArgs(["--min-coverage=100"]).minCoverage).toBe(100);
  });

  it("does not leak `only` between calls", () => {
    parseArgs(["--only=states"]);
    expect(parseArgs([]).only).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// SQL construction
// ---------------------------------------------------------------------------

describe("ident", () => {
  it("quotes a plain identifier", () => {
    expect(ident("vehicle_variants")).toBe(`"vehicle_variants"`);
    expect(ident("__n__ex_showroom_paise")).toBe(`"__n__ex_showroom_paise"`);
  });

  it("refuses anything that could break out of the quotes", () => {
    for (const bad of [`a"; drop table x; --`, "Mixed", "a b", "", "1abc"]) {
      expect(() => ident(bad)).toThrow(/Refusing to build SQL/);
    }
  });
});

describe("buildCompletenessQuery", () => {
  it("casts every count to int — postgres.js returns an uncast count as a string", () => {
    const query = buildCompletenessQuery("states", [
      { field: "region", column: "region" },
    ]);
    for (const fragment of query.match(/count\([^)]*\)(\s*filter\s*\([^)]*\))?/g) ?? []) {
      expect(query).toContain(`${fragment}`);
    }
    expect(query).toContain(`count(*)::int as "__total"`);
    expect(query.match(/::int/g)?.length).toBe(3);
  });

  it("emits an applicable denominator alongside every present count", () => {
    const query = buildCompletenessQuery("vehicle_variants", [
      {
        field: "realWorldRangeKm",
        column: "real_world_range_km",
        appliesWhen: `"fuel_type" = 'electric'`,
      },
    ]);
    expect(query).toContain(
      `(count(*) filter (where ("fuel_type" = 'electric') and "real_world_range_km" is not null))::int as "real_world_range_km"`,
    );
    expect(query).toContain(
      `(count(*) filter (where "fuel_type" = 'electric'))::int as "__n__real_world_range_km"`,
    );
  });

  it("measures a jsonb array by length, because `[]` is not a populated fact", () => {
    const query = buildCompletenessQuery("vehicle_models", [
      { field: "knownAdvantages", column: "known_advantages", kind: "jsonbArray" },
    ]);
    expect(query).toContain(`jsonb_array_length("known_advantages") > 0`);
    expect(query).not.toContain(`"known_advantages" is not null`);
  });

  it("uses `true` as the denominator for an unconditional column", () => {
    const query = buildCompletenessQuery("states", [{ field: "region", column: "region" }]);
    expect(query).toContain(`(count(*) filter (where true))::int as "__n__region"`);
  });

  it("refuses to build SQL from an identifier it did not derive from the schema", () => {
    expect(() =>
      buildCompletenessQuery("states", [{ field: "x", column: `region"; drop table states; --` }]),
    ).toThrow(/Refusing to build SQL/);
  });
});

describe("buildStalenessQuery", () => {
  it("treats a null verification column as stale", () => {
    const query = buildStalenessQuery("vehicle_variants", "last_verified_at", 180);
    expect(query).toContain(`"last_verified_at" is null`);
    expect(query).toContain(`make_interval(days => 180)`);
  });

  it("rejects a non-integer window rather than interpolating it", () => {
    expect(() => buildStalenessQuery("t", "c", 1.5)).toThrow();
    expect(() => buildStalenessQuery("t", "c", 0)).toThrow();
  });
});

describe("resolveFields", () => {
  it("converts the TS property name to the SQL column name", () => {
    const { resolved } = resolveFields(
      { exShowroomPaise: {}, dcChargeMinutes10To80: {} },
      [{ field: "exShowroomPaise" }, { field: "dcChargeMinutes10To80" }],
    );
    expect(resolved.map((f) => f.column)).toEqual([
      "ex_showroom_paise",
      "dc_charge_minutes10_to80",
    ]);
  });

  it("reports a column the schema no longer has instead of querying for it", () => {
    const { resolved, missing } = resolveFields({ a: {} }, [{ field: "a" }, { field: "gone" }]);
    expect(resolved).toHaveLength(1);
    expect(missing).toEqual(["gone"]);
  });
});

// ---------------------------------------------------------------------------
// scoring
// ---------------------------------------------------------------------------

describe("pct", () => {
  it("returns null for a zero denominator — not applicable is not zero percent", () => {
    expect(pct(0, 0)).toBeNull();
    expect(pct(5, 0)).toBeNull();
    expect(pct(1, 4)).toBe(25);
  });
});

describe("computeCoverage — the empty-database policy", () => {
  it("passes when every curated table is empty", () => {
    const result = run([
      finding({ table: "vehicle_variants", rowCount: 0 }),
      finding({ table: "sources", rowCount: 0 }),
    ]);
    expect(result.passed).toBe(true);
    expect(result.criticalPct).toBeNull();
    expect(result.unpopulatedCurated).toEqual(["vehicle_variants", "sources"]);
    expect(exitCodeFor(result)).toBe(0);
  });

  it("excludes empty tables from the averages rather than scoring them 0%", () => {
    const result = run([
      finding({ table: "vehicle_variants", rowCount: 0, columns: [column("a", 0, 0)] }),
      finding({ table: "cities", kind: "reference", rowCount: 4, columns: [column("b", 4, 4)] }),
    ]);
    expect(result.criticalPct).toBe(100);
    expect(result.criticalApplicable).toBe(4);
  });

  it("fails on an empty curated table under --strict", () => {
    const result = run([finding({ rowCount: 0 })], [], { strict: true });
    expect(result.passed).toBe(false);
    expect(result.failures.join(" ")).toMatch(/curated table\(s\) are empty/);
    expect(exitCodeFor(result)).toBe(1);
  });

  it("goes red the moment the catalogue lands half-sourced", () => {
    const result = run([
      finding({ rowCount: 100, columns: [column("ex_showroom_paise", 50, 100)] }),
    ]);
    expect(result.criticalPct).toBe(50);
    expect(result.passed).toBe(false);
    expect(result.failures.join(" ")).toMatch(/critical completeness 50\.0% is below the 90%/);
  });

  it("does not gate on a non-critical shortfall", () => {
    const result = run([
      finding({
        rowCount: 100,
        columns: [column("boot_litres", 0, 100, false), column("ex_showroom_paise", 100, 100)],
      }),
    ]);
    expect(result.overallPct).toBe(50);
    expect(result.criticalPct).toBe(100);
    expect(result.passed).toBe(true);
  });

  it("does not count a petrol car as missing an EV-only column", () => {
    // 100 rows, 10 of them EV, all 10 have a range. Naive scoring would call
    // this 10%; the applicable denominator makes it 100%.
    const result = run([
      finding({ rowCount: 100, columns: [column("real_world_range_km", 10, 10)] }),
    ]);
    expect(result.criticalPct).toBe(100);
    expect(result.passed).toBe(true);
  });
});

describe("computeCoverage — provenance", () => {
  it("fails when facts outrun their provenance rows", () => {
    const result = run([
      finding({
        rowCount: 10,
        provenance: [{ column: "ex_showroom_paise", covered: 5, expected: 10 }],
      }),
    ]);
    expect(result.provenancePct).toBe(50);
    expect(result.failures.join(" ")).toMatch(/provenance coverage 50\.0%/);
  });

  it("clamps coverage at the number of facts that exist, so a stray row cannot inflate it", () => {
    const result = run([
      finding({
        rowCount: 10,
        provenance: [
          { column: "a", covered: 40, expected: 10 },
          { column: "b", covered: 0, expected: 10 },
        ],
      }),
    ]);
    expect(result.provenanceCovered).toBe(10);
    expect(result.provenancePct).toBe(50);
  });

  it("always fails on an orphaned provenance row — entity_id carries no foreign key", () => {
    const result = run([
      finding({
        rowCount: 10,
        orphanProvenance: 3,
        provenance: [{ column: "a", covered: 10, expected: 10 }],
      }),
    ]);
    expect(result.orphanProvenanceTotal).toBe(3);
    expect(result.failures.join(" ")).toMatch(/point at an entity_id that no longer exists/);
  });

  it("counts orphans on a table that is otherwise empty", () => {
    const result = run([finding({ rowCount: 0, orphanProvenance: 2 })]);
    expect(result.orphanProvenanceTotal).toBe(2);
    expect(result.passed).toBe(false);
  });
});

describe("computeCoverage — anomalies and drift", () => {
  it("fails when claimed_* exists without real_world_*", () => {
    const result = run([
      finding({ rowCount: 10, anomalies: ["4 variant(s) have claimed_efficiency but no ..."] }),
    ]);
    expect(result.passed).toBe(false);
    expect(result.failures.join(" ")).toMatch(/vehicle_variants: 4 variant\(s\)/);
  });

  it("fails, and says to migrate, when a table is missing from the database", () => {
    const result = run([finding({ table: "vehicle_variants", exists: false })]);
    expect(result.missingTables).toEqual(["vehicle_variants"]);
    expect(result.failures.join(" ")).toMatch(/run pnpm db:migrate/);
  });

  it("fails when the spec names a column the schema no longer has", () => {
    const result = run([finding({ schemaDrift: ["gone"] })]);
    expect(result.schemaDrift).toEqual(["vehicle_variants.gone"]);
    expect(result.failures.join(" ")).toMatch(/columns that no longer exist/);
  });

  it("reports drift even for a table that is missing from the database", () => {
    const result = run([finding({ exists: false, schemaDrift: ["gone"] })]);
    expect(result.schemaDrift).toEqual(["vehicle_variants.gone"]);
  });
});

describe("computeCoverage — reference checks and staleness", () => {
  it("gates on a critical check but only reports a non-critical one", () => {
    const result = run(
      [],
      [
        check({ name: "critical one", critical: true, covered: 1, total: 10 }),
        check({ name: "advisory one", critical: false, covered: 1, total: 10 }),
      ],
    );
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatch(/critical one/);
  });

  it("ignores a check whose measured table is empty", () => {
    const result = run([], [check({ skipped: "unpopulated" })]);
    expect(result.passed).toBe(true);
    expect(result.checkPct).toBeNull();
    expect(result.unpopulatedChecks).toEqual(["a check"]);
  });

  it("fails an unpopulated check under --strict", () => {
    const result = run([], [check({ skipped: "unpopulated" })], { strict: true });
    expect(result.failures.join(" ")).toMatch(/nothing to measure/);
  });

  it("reports staleness but does not gate on it by default", () => {
    const stale = finding({
      rowCount: 10,
      staleness: { column: "last_verified_at", days: 180, stale: 9, total: 10 },
    });
    expect(run([stale]).stalePct).toBe(90);
    expect(run([stale]).passed).toBe(true);
    expect(run([stale], [], { maxStalePct: 50 }).passed).toBe(false);
  });
});

describe("exitCodeFor", () => {
  it("is 0 on pass and 1 on a gate failure", () => {
    expect(exitCodeFor(run([]))).toBe(0);
    expect(exitCodeFor(run([finding({ exists: false })]))).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// diagnostics
// ---------------------------------------------------------------------------

describe("diagnose", () => {
  it.each([
    ["ECONNREFUSED", /Cannot reach the database/],
    ["ENOTFOUND", /Cannot reach the database/],
    ["CONNECT_TIMEOUT", /Cannot reach the database/],
    ["28P01", /rejected the credentials/],
    ["3D000", /does not exist/],
    ["42P01", /pnpm db:migrate/],
  ])("maps %s to exit 3 with a one-line diagnostic", (code, message) => {
    const result = diagnose(Object.assign(new Error("boom"), { code }));
    expect(result.code).toBe(3);
    expect(result.message).toMatch(message);
    expect(result.message).not.toContain("\n");
  });

  it("treats an unrecognised failure as a validation failure, not an infra failure", () => {
    expect(diagnose(new Error("something else"))).toEqual({
      code: 1,
      message: "Validation failed: something else",
    });
  });

  it("survives a thrown non-Error without a code", () => {
    expect(diagnose("just a string").code).toBe(1);
    expect(diagnose(undefined).code).toBe(1);
    expect(diagnose({ code: undefined }).code).toBe(1);
  });
});

describe("describeDatabase", () => {
  it("shows host and database but never the credentials", () => {
    const described = describeDatabase("postgres://user:hunter2@db.example.com:5432/neondb");
    expect(described).toBe("db.example.com:5432/neondb");
    expect(described).not.toContain("hunter2");
    expect(described).not.toContain("user");
  });

  it("does not throw on an unparseable URL", () => {
    expect(describeDatabase("not a url")).toBe("(unparseable DATABASE_URL)");
  });
});

// ---------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------

describe("formatReport", () => {
  it("prints PASS, the unpopulated tables, and no credentials", () => {
    const text = formatReport(
      run([finding({ table: "vehicle_variants", rowCount: 0 })]),
      "db.example.com/neondb",
    );
    expect(text).toContain("UNPOPULATED");
    expect(text).toContain("result:");
    expect(text).toContain("PASS");
    expect(text).toContain("db.example.com/neondb");
  });

  it("prints FAIL and lists every failure", () => {
    const text = formatReport(
      run([finding({ rowCount: 10, columns: [column("ex_showroom_paise", 1, 10)] })]),
      "x",
    );
    expect(text).toContain("FAIL");
    expect(text).toContain("FAILURES");
    expect(text).toMatch(/ex_showroom_paise\s+1\/10\s+10\.0%/);
  });

  it("flags a camelCase fact_provenance.field, which cannot be joined", () => {
    const text = formatReport(
      run([finding({ rowCount: 10, provenanceFieldForms: { snake: 0, camel: 4 } })]),
      "x",
    );
    expect(text).toMatch(/camelCase for 4 row\(s\)/);
  });

  it("does not spell out a column that is fully populated", () => {
    const text = formatReport(
      run([finding({ rowCount: 10, columns: [column("ex_showroom_paise", 10, 10)] })]),
      "x",
    );
    expect(text).not.toContain("ex_showroom_paise ");
  });
});

describe("formatJson", () => {
  it("round-trips through JSON with the gate result intact", () => {
    const result = run([finding({ rowCount: 10, columns: [column("a", 1, 10)] })]);
    const parsed = JSON.parse(JSON.stringify(formatJson(result, "x"))) as {
      passed: boolean;
      summary: { criticalPct: number };
      failures: string[];
    };
    expect(parsed.passed).toBe(false);
    expect(parsed.summary.criticalPct).toBe(10);
    expect(parsed.failures.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// the spec vs the real schema — drift guards
// ---------------------------------------------------------------------------

describe("the validation spec matches src/db/schema", () => {
  const tables = discoverTables();

  it("finds all 38 tables (a CJS entry point resolves the `export *` barrel)", () => {
    expect(tables.size).toBe(38);
  });

  it("covers every table in the schema exactly once", () => {
    const specced = TABLE_SPECS.map((spec) => spec.table);
    expect(new Set(specced).size).toBe(specced.length);
    expect([...specced].sort()).toEqual([...tables.keys()].sort());
  });

  it("names only columns that exist, under the property name Drizzle uses", () => {
    for (const spec of TABLE_SPECS) {
      const table = tables.get(spec.table);
      expect(table, `${spec.table} is not in the schema`).toBeDefined();
      const columns = getTableColumns(table!) as unknown as Record<string, unknown>;
      for (const field of spec.fields ?? []) {
        expect(Object.keys(columns), `${spec.table}.${field.field}`).toContain(field.field);
      }
      for (const field of spec.displayOnly ?? []) {
        expect(Object.keys(columns), `${spec.table}.${field}`).toContain(field);
      }
      if (spec.stalenessColumn) {
        expect(Object.keys(columns), `${spec.table}.${spec.stalenessColumn}`).toContain(
          spec.stalenessColumn,
        );
      }
      if (spec.sourceColumn) {
        expect(Object.keys(columns), `${spec.table}.${spec.sourceColumn}`).toContain(
          spec.sourceColumn,
        );
      }
    }
  });

  it("only expects provenance on a table whose id is a uuid", () => {
    // fact_provenance.entity_id is `uuid not null`, so `states` (text primary
    // key) can never carry a provenance row and must never be in the denominator.
    for (const spec of TABLE_SPECS) {
      const wants = (spec.fields ?? []).some((field) => field.provenance);
      if (!wants) continue;
      const columns = getTableColumns(tables.get(spec.table)!) as unknown as Record<
        string,
        { columnType: string }
      >;
      expect(columns.id?.columnType, `${spec.table}.id`).toBe("PgUUID");
    }
    expect(TABLE_SPECS.find((s) => s.table === "states")?.fields?.some((f) => f.provenance)).toBe(
      false,
    );
  });

  it("gates on the real-world figures and never on the claimed ones", () => {
    const spec = TABLE_SPECS.find((s) => s.table === "vehicle_variants")!;
    const critical = (spec.fields ?? []).filter((f) => f.critical).map((f) => f.field);
    expect(critical).toEqual(
      expect.arrayContaining([
        "realWorldEfficiencyCity",
        "realWorldEfficiencyHighway",
        "realWorldRangeKm",
        "exShowroomPaise",
        "seatingCapacity",
      ]),
    );
    expect(critical).not.toContain("claimedEfficiency");
    expect(critical).not.toContain("claimedRangeKm");
    // Reported, but never scored and never a source of a calculation.
    expect(spec.displayOnly).toEqual(["claimedEfficiency", "claimedRangeKm"]);
    for (const field of spec.fields ?? []) {
      expect(field.field.startsWith("claimed")).toBe(false);
    }
  });

  it("never scores an operational table", () => {
    for (const spec of TABLE_SPECS) {
      if (spec.kind !== "operational") continue;
      expect(spec.fields ?? [], `${spec.table} should be row-count only`).toHaveLength(0);
    }
  });

  it("gives every coverage check a table that must exist and one it measures", () => {
    const names = new Set([...tables.keys()]);
    for (const check of COVERAGE_CHECKS) {
      expect(check.requires.length).toBeGreaterThan(0);
      expect(check.measures.length).toBeGreaterThan(0);
      for (const table of [...check.requires, ...check.measures]) {
        expect(names, `${check.name} -> ${table}`).toContain(table);
      }
      // A check can only be trusted if the tables it measures are also the
      // tables it declares it needs.
      for (const table of check.measures) expect(check.requires).toContain(table);
    }
  });

  it("resolves the awkward column names the same way Drizzle does", () => {
    const variants = getTableColumns(tables.get("vehicle_variants")!) as unknown as Record<
      string,
      { name: string }
    >;
    // The trap: column.name is the TS property, not the SQL name.
    expect(variants.exShowroomPaise.name).toBe("exShowroomPaise");
    expect(toSnakeCase("exShowroomPaise")).toBe("ex_showroom_paise");
    expect(toSnakeCase("dcChargeMinutes10To80")).toBe("dc_charge_minutes10_to80");
    expect(toSnakeCase("scheduledServiceCost5yPaise")).toBe("scheduled_service_cost5y_paise");
    expect(getTableName(tables.get("vehicle_variants")!)).toBe("vehicle_variants");
  });
});
