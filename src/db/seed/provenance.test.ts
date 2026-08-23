import { describe, expect, it } from "vitest";

import { FIXTURE_ENTITIES, type FixtureVariantInsert } from "./fixtures/sample-entities";
import {
  buildProvenanceRows,
  planFieldChanges,
  planProvenance,
  sameAuthoredColumns,
  sameColumnValue,
  splitEntity,
  todayIso,
  type DesiredProvenance,
  type ExistingProvenance,
  type SeedEntity,
} from "./provenance";

const TODAY = "2026-08-23";
const SOURCE_A = "11111111-1111-4111-8111-111111111111";
const SOURCE_B = "22222222-2222-4222-8222-222222222222";

const SOURCE_IDS = new Map([
  ["fixture-source", SOURCE_A],
  ["fixture-source-b", SOURCE_B],
]);

const SQL_NAMES: Record<string, string> = {
  slug: "slug",
  modelId: "model_id",
  name: "name",
  status: "status",
  realWorldEfficiencyCity: "real_world_efficiency_city",
  exShowroomPaise: "ex_showroom_paise",
  knownAdvantages: "known_advantages",
};

const buildOpts = (entityKey: string) => ({
  entityKey,
  entityTable: "vehicle_variants",
  sqlFieldName: (field: string) => SQL_NAMES[field] ?? field,
  sourceId: (slug: string) => SOURCE_IDS.get(slug),
});

/** The full pipeline one entity goes through, minus the database. */
function provenanceFor(entity: SeedEntity<FixtureVariantInsert>): DesiredProvenance[] {
  const split = splitEntity(entity, { today: TODAY });
  return buildProvenanceRows(split.facts, buildOpts(entity.key));
}

function asExisting(rows: readonly DesiredProvenance[]): ExistingProvenance[] {
  return rows.map(({ field, sourceId, sourceUrl, excerpt, confidence, verifiedAt }) => ({
    field,
    sourceId,
    sourceUrl,
    excerpt,
    confidence,
    verifiedAt,
  }));
}

describe("sameColumnValue", () => {
  it("treats a zero-padded numeric as the value the seed authored", () => {
    // numeric(6,2) comes back from Postgres as "12.00". Without this the diff
    // reports an update on every run, and every update supersedes provenance.
    expect(sameColumnValue("12", "12.00")).toBe(true);
    expect(sameColumnValue("12.5", "12.50")).toBe(true);
    expect(sameColumnValue(18, "18.00")).toBe(true);
    expect(sameColumnValue("12", "13.00")).toBe(false);
  });

  it("does not let empty or blank strings collapse into zero", () => {
    expect(sameColumnValue("", "0")).toBe(false);
    expect(sameColumnValue("   ", 0)).toBe(false);
  });

  it("unifies null and undefined but never null and a value", () => {
    expect(sameColumnValue(null, undefined)).toBe(true);
    expect(sameColumnValue(undefined, null)).toBe(true);
    expect(sameColumnValue(null, null)).toBe(true);
    expect(sameColumnValue(null, 0)).toBe(false);
    expect(sameColumnValue(0, null)).toBe(false);
    expect(sameColumnValue(null, "")).toBe(false);
    expect(sameColumnValue(null, [])).toBe(false);
  });

  it("compares timestamps by instant, across Date and string", () => {
    expect(sameColumnValue(new Date("2026-01-01T00:00:00Z"), new Date(1767225600000))).toBe(true);
    expect(sameColumnValue(new Date("2026-01-01T00:00:00Z"), "2026-01-01T00:00:00.000Z")).toBe(
      true,
    );
    expect(sameColumnValue(new Date("2026-01-01T00:00:00Z"), "not a date")).toBe(false);
    expect(sameColumnValue(new Date("2026-01-01T00:00:00Z"), new Date("2026-01-02T00:00:00Z"))).toBe(
      false,
    );
  });

  it("treats a jsonb array as a list — reordering it is a real change", () => {
    expect(sameColumnValue(["a", "b"], ["a", "b"])).toBe(true);
    expect(sameColumnValue(["a", "b"], ["b", "a"])).toBe(false);
    expect(sameColumnValue(["a"], ["a", "b"])).toBe(false);
    expect(sameColumnValue([], [])).toBe(true);
  });

  it("compares jsonb objects structurally, regardless of key order", () => {
    expect(sameColumnValue({ issue: "x", typicalKm: 60000 }, { typicalKm: 60000, issue: "x" })).toBe(
      true,
    );
    expect(sameColumnValue({ issue: "x" }, { issue: "x", severity: "low" })).toBe(false);
    expect(sameColumnValue({ issue: "x" }, { issue: "y" })).toBe(false);
    expect(sameColumnValue([{ a: 1 }], [{ a: 1 }])).toBe(true);
  });

  it("keeps booleans and numbers apart", () => {
    expect(sameColumnValue(true, 1)).toBe(false);
    expect(sameColumnValue(false, 0)).toBe(false);
    expect(sameColumnValue(true, true)).toBe(true);
  });
});

describe("sameAuthoredColumns", () => {
  it("ignores columns the seed file never mentioned", () => {
    const existing = {
      slug: "fixture-variant-a",
      name: "Fixture Variant A",
      createdAt: new Date("2020-01-01T00:00:00Z"),
      updatedAt: new Date("2026-08-01T00:00:00Z"),
      dataQualityScore: 71,
    };
    expect(sameAuthoredColumns({ slug: "fixture-variant-a", name: "Fixture Variant A" }, existing)).toBe(
      true,
    );
  });

  it("reports a changed authored column", () => {
    expect(sameAuthoredColumns({ name: "A" }, { name: "B" })).toBe(false);
  });
});

describe("splitEntity", () => {
  it("merges identity and fact values into one row and lifts the facts out", () => {
    const split = splitEntity(FIXTURE_ENTITIES[0], { today: TODAY });

    expect(split.values).toEqual({
      slug: "fixture-variant-a",
      modelId: "00000000-0000-4000-8000-000000000001",
      name: "Fixture Variant A",
      status: "active",
      realWorldEfficiencyCity: "12",
      exShowroomPaise: 10_000_000,
      knownAdvantages: ["fixture-advantage-1", "fixture-advantage-2"],
    });
    expect(split.facts.map((f) => f.field)).toEqual([
      "realWorldEfficiencyCity",
      "exShowroomPaise",
      "knownAdvantages",
    ]);
  });

  it("keeps a known-absent fact as null rather than dropping the column", () => {
    const split = splitEntity(FIXTURE_ENTITIES[1], { today: TODAY });

    expect(split.values.realWorldEfficiencyCity).toBeNull();
    // The null is still evidence-backed: "this source publishes no figure".
    expect(split.facts).toHaveLength(1);
    expect(split.facts[0].sourced.excerpt).toMatch(/publishes no city figure/);
  });

  it("rejects a column that is both structural and sourced", () => {
    const entity: SeedEntity<FixtureVariantInsert> = {
      key: "fixture-variant-c",
      identity: { slug: "fixture-variant-c", exShowroomPaise: 100 },
      facts: {
        exShowroomPaise: { value: 200, source: "fixture-source", verifiedAt: "2026-01-01" },
      },
    };

    expect(() => splitEntity(entity, { today: TODAY })).toThrow(
      /"exShowroomPaise" appears in both identity and facts/,
    );
  });

  it("refuses a verifiedAt in the future rather than inventing a verification", () => {
    const entity: SeedEntity<FixtureVariantInsert> = {
      key: "fixture-variant-d",
      identity: { slug: "fixture-variant-d" },
      facts: {
        exShowroomPaise: { value: 100, source: "fixture-source", verifiedAt: "2999-01-01" },
      },
    };

    expect(() => splitEntity(entity, { today: TODAY })).toThrow(/is in the future/);
  });

  it("refuses a missing or malformed verifiedAt — it is never defaulted to today", () => {
    const missing = {
      key: "fixture-variant-e",
      identity: { slug: "fixture-variant-e" },
      facts: { exShowroomPaise: { value: 100, source: "fixture-source" } },
    } as unknown as SeedEntity<FixtureVariantInsert>;
    expect(() => splitEntity(missing, { today: TODAY })).toThrow(/must be an ISO date/);

    const malformed = {
      key: "fixture-variant-e",
      identity: { slug: "fixture-variant-e" },
      facts: {
        exShowroomPaise: { value: 100, source: "fixture-source", verifiedAt: "15/01/2026" },
      },
    } as unknown as SeedEntity<FixtureVariantInsert>;
    expect(() => splitEntity(malformed, { today: TODAY })).toThrow(/must be an ISO date/);

    const impossible = {
      key: "fixture-variant-e",
      identity: { slug: "fixture-variant-e" },
      facts: {
        exShowroomPaise: { value: 100, source: "fixture-source", verifiedAt: "2026-02-31" },
      },
    } as unknown as SeedEntity<FixtureVariantInsert>;
    expect(() => splitEntity(impossible, { today: TODAY })).toThrow(/is not a real date/);
  });

  it("refuses a fact with no source", () => {
    const entity = {
      key: "fixture-variant-f",
      identity: { slug: "fixture-variant-f" },
      facts: { exShowroomPaise: { value: 100, source: "  ", verifiedAt: "2026-01-01" } },
    } as unknown as SeedEntity<FixtureVariantInsert>;

    expect(() => splitEntity(entity, { today: TODAY })).toThrow(/needs a non-empty `source`/);
  });

  it("refuses an unrecognised confidence level", () => {
    const entity = {
      key: "fixture-variant-g",
      identity: { slug: "fixture-variant-g" },
      facts: {
        exShowroomPaise: {
          value: 100,
          source: "fixture-source",
          verifiedAt: "2026-01-01",
          confidence: "very-high",
        },
      },
    } as unknown as SeedEntity<FixtureVariantInsert>;

    expect(() => splitEntity(entity, { today: TODAY })).toThrow(/confidence` must be one of/);
  });

  it("refuses rupee floats in a paise column", () => {
    const entity: SeedEntity<FixtureVariantInsert> = {
      key: "fixture-variant-h",
      identity: { slug: "fixture-variant-h" },
      facts: {
        exShowroomPaise: { value: 12345.6, source: "fixture-source", verifiedAt: "2026-01-01" },
      },
    };

    expect(() => splitEntity(entity, { today: TODAY })).toThrow(/money is paise as a safe integer/);
  });

  it("allows a paise column to be an evidence-backed null", () => {
    const entity: SeedEntity<FixtureVariantInsert> = {
      key: "fixture-variant-i",
      identity: { slug: "fixture-variant-i" },
      facts: {
        exShowroomPaise: { value: null, source: "fixture-source", verifiedAt: "2026-01-01" },
      },
    };

    expect(splitEntity(entity, { today: TODAY }).values.exShowroomPaise).toBeNull();
  });

  it("distinguishes an absent value from an explicit null", () => {
    const entity = {
      key: "fixture-variant-j",
      identity: { slug: "fixture-variant-j" },
      facts: { exShowroomPaise: { source: "fixture-source", verifiedAt: "2026-01-01" } },
    } as unknown as SeedEntity<FixtureVariantInsert>;

    expect(() => splitEntity(entity, { today: TODAY })).toThrow(/has no value/);
  });

  it("refuses an entity with no natural key", () => {
    const entity = { key: "", identity: {}, facts: {} } as SeedEntity<FixtureVariantInsert>;
    expect(() => splitEntity(entity, { today: TODAY })).toThrow(/missing a natural key/);
  });
});

describe("buildProvenanceRows", () => {
  it("records SQL column names and defaults confidence to the column default", () => {
    const rows = provenanceFor(FIXTURE_ENTITIES[0]);

    expect(rows).toEqual([
      {
        field: "real_world_efficiency_city",
        sourceId: SOURCE_A,
        sourceUrl: "https://fixture.invalid/a",
        excerpt: "Fixture excerpt A.",
        confidence: "high",
        verifiedAt: "2026-01-15",
        meta: null,
      },
      {
        field: "ex_showroom_paise",
        sourceId: SOURCE_A,
        sourceUrl: null,
        excerpt: null,
        confidence: "medium",
        verifiedAt: "2026-01-15",
        meta: null,
      },
      {
        field: "known_advantages",
        sourceId: SOURCE_B,
        sourceUrl: null,
        excerpt: null,
        confidence: "low",
        verifiedAt: "2026-02-01",
        meta: null,
      },
    ]);
  });

  it("gives each field its own source — provenance is not per row", () => {
    const rows = provenanceFor(FIXTURE_ENTITIES[0]);
    expect(new Set(rows.map((r) => r.sourceId)).size).toBe(2);
    expect(new Set(rows.map((r) => r.verifiedAt)).size).toBe(2);
  });

  it("fails loudly, and usefully, on a source slug that is not in the sources table", () => {
    const split = splitEntity(FIXTURE_ENTITIES[0], { today: TODAY });
    expect(() =>
      buildProvenanceRows(split.facts, {
        ...buildOpts("fixture-variant-a"),
        sourceId: () => undefined,
      }),
    ).toThrow(
      /Unknown source slug "fixture-source" on vehicle_variants\.real_world_efficiency_city \(fixture-variant-a\) — add it to SOURCE_SEED_ROWS\./,
    );
  });
});

describe("planProvenance", () => {
  it("records everything on a first import", () => {
    const plan = planProvenance(provenanceFor(FIXTURE_ENTITIES[0]), []);

    expect(plan.toInsert).toHaveLength(3);
    expect(plan.toSupersede).toEqual([]);
    expect(plan.unchanged).toBe(0);
  });

  it("writes nothing on a re-run — the regression that matters", () => {
    const desired = provenanceFor(FIXTURE_ENTITIES[0]);
    const plan = planProvenance(desired, asExisting(desired));

    expect(plan).toEqual({ toInsert: [], toSupersede: [], unchanged: 3 });
  });

  it("supersedes and re-records when only the confidence changed", () => {
    const desired = provenanceFor(FIXTURE_ENTITIES[0]);
    const live = asExisting(desired);
    live[0] = { ...live[0], confidence: "medium" };

    const plan = planProvenance(desired, live);

    expect(plan.toSupersede).toEqual(["real_world_efficiency_city"]);
    expect(plan.toInsert.map((r) => r.field)).toEqual(["real_world_efficiency_city"]);
    expect(plan.unchanged).toBe(2);
  });

  it.each([
    ["sourceId", { sourceId: SOURCE_B }],
    ["sourceUrl", { sourceUrl: "https://fixture.invalid/other" }],
    ["excerpt", { excerpt: "Different fixture excerpt." }],
    ["verifiedAt", { verifiedAt: "2025-12-01" }],
  ])("supersedes when %s changed", (_label, patch) => {
    const desired = provenanceFor(FIXTURE_ENTITIES[0]);
    const live = asExisting(desired);
    live[0] = { ...live[0], ...patch } as ExistingProvenance;

    expect(planProvenance(desired, live).toSupersede).toEqual(["real_world_efficiency_city"]);
  });

  it("ignores meta — annotation is not evidence and must not cost a supersession", () => {
    const desired = provenanceFor(FIXTURE_ENTITIES[0]).map((row) => ({
      ...row,
      meta: { parser: "v2" },
    }));
    const plan = planProvenance(desired, asExisting(desired));

    expect(plan.toSupersede).toEqual([]);
    expect(plan.unchanged).toBe(3);
  });

  it("leaves a fact the seed stopped mentioning current, rather than deleting it", () => {
    const desired = provenanceFor(FIXTURE_ENTITIES[0]);
    const live = [
      ...asExisting(desired),
      {
        field: "curated_by_hand",
        sourceId: SOURCE_B,
        sourceUrl: null,
        excerpt: null,
        confidence: "high" as const,
        verifiedAt: "2026-03-01",
      },
    ];

    const plan = planProvenance(desired, live);

    expect(plan).toEqual({ toInsert: [], toSupersede: [], unchanged: 3 });
  });

  it("records a fact that is new on an entity that already has others", () => {
    const desired = provenanceFor(FIXTURE_ENTITIES[0]);
    const plan = planProvenance(desired, asExisting(desired).slice(0, 2));

    expect(plan.toSupersede).toEqual([]);
    expect(plan.toInsert.map((r) => r.field)).toEqual(["known_advantages"]);
    expect(plan.unchanged).toBe(2);
  });

  it("rejects two provenance rows for the same field — the partial index forbids it", () => {
    const [row] = provenanceFor(FIXTURE_ENTITIES[0]);
    expect(() => planProvenance([row, row], [])).toThrow(
      /Duplicate provenance field: real_world_efficiency_city/,
    );
  });

  it("handles an entity whose facts are all null-valued", () => {
    const desired = provenanceFor(FIXTURE_ENTITIES[1]);
    expect(desired).toHaveLength(1);
    expect(planProvenance(desired, []).toInsert).toHaveLength(1);
    expect(planProvenance(desired, asExisting(desired)).unchanged).toBe(1);
  });
});

describe("planFieldChanges", () => {
  it("emits one entry per changed authored column, with the old and new values", () => {
    const changes = planFieldChanges(
      { name: "Fixture Variant A2", realWorldEfficiencyCity: "13", exShowroomPaise: 10_000_000 },
      {
        name: "Fixture Variant A",
        realWorldEfficiencyCity: "12.00",
        exShowroomPaise: 10_000_000,
        updatedAt: new Date("2026-01-01T00:00:00Z"),
      },
    );

    expect(changes).toEqual([
      { field: "name", oldValue: "Fixture Variant A", newValue: "Fixture Variant A2" },
      { field: "realWorldEfficiencyCity", oldValue: "12.00", newValue: "13" },
    ]);
  });

  it("normalises an absent previous value to null rather than undefined", () => {
    expect(planFieldChanges({ bootLitres: 300 }, {})).toEqual([
      { field: "bootLitres", oldValue: null, newValue: 300 },
    ]);
  });

  it("says nothing when a padded numeric round-trips unchanged", () => {
    expect(planFieldChanges({ realWorldEfficiencyCity: "12" }, { realWorldEfficiencyCity: "12.00" })).toEqual(
      [],
    );
  });
});

describe("todayIso", () => {
  it("formats as the YYYY-MM-DD that fact_provenance.verifiedAt stores", () => {
    expect(todayIso(new Date("2026-08-23T18:30:00Z"))).toBe("2026-08-23");
  });
});
