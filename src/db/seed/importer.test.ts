import { getTableColumns, getTableName, type InferInsertModel } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { vehicleVariants } from "../schema/catalogue";
import { factProvenance } from "../schema/sources";
import { FakeTx } from "./fixtures/fake-tx";
import { importEntities, loadSourceIds, sqlColumnName } from "./importer";
import type { SeedEntity } from "./provenance";

/**
 * These touch the schema definitions but never Postgres — Drizzle table objects
 * are plain values. Everything that needs a connection is covered by
 * `pnpm db:seed --dry-run` instead, because CI runs with no DATABASE_URL.
 */
describe("sqlColumnName", () => {
  const columns = getTableColumns(vehicleVariants);

  it("resolves the snake_case SQL name, not the camelCase property key", () => {
    // `casing: "snake_case"` lives on the client, so `column.name` is still
    // "realWorldEfficiencyCity" here. Storing that under entity_table
    // "vehicle_variants" would give fact_provenance a key whose two halves
    // disagree — and nothing downstream could join on it.
    expect(columns.realWorldEfficiencyCity.name).toBe("realWorldEfficiencyCity");
    expect(sqlColumnName(columns.realWorldEfficiencyCity)).toBe("real_world_efficiency_city");
  });

  it("handles the column shapes the catalogue actually uses", () => {
    expect(sqlColumnName(columns.exShowroomPaise)).toBe("ex_showroom_paise");
    expect(sqlColumnName(columns.scheduledServiceCost5yPaise)).toBe(
      "scheduled_service_cost5y_paise",
    );
    expect(sqlColumnName(columns.dcChargeMinutes10To80)).toBe("dc_charge_minutes10_to80");
    expect(sqlColumnName(columns.slug)).toBe("slug");
    expect(sqlColumnName(columns.e20Verdict)).toBe("e20_verdict");
  });

  it("names the display-only claimed columns too — they are sourced, just never computed on", () => {
    // The ban is on using these in arithmetic, not on attributing them.
    expect(sqlColumnName(columns.claimedEfficiency)).toBe("claimed_efficiency");
    expect(sqlColumnName(columns.claimedRangeKm)).toBe("claimed_range_km");
  });
});

describe("provenance target", () => {
  it("keys on the SQL table name, which is what entityTable stores", () => {
    expect(getTableName(vehicleVariants)).toBe("vehicle_variants");
  });

  it("has a uuid id column, which is what entityId requires", () => {
    // fact_provenance.entityId is `uuid NOT NULL`, so a text-keyed table like
    // `states` (primary key `code`) can never carry provenance rows. That is
    // why ImportSpec is constrained to `PgTable & { id: PgColumn }`.
    expect(vehicleVariants.id.columnType).toBe("PgUUID");
    expect(factProvenance.entityId.columnType).toBe("PgUUID");
    expect(factProvenance.verifiedAt.columnType).toBe("PgDateString");
    expect(factProvenance.supersededAt.columnType).toBe("PgTimestamp");
  });
});

// ---------------------------------------------------------------------------
// The write plan, driven through a recording stand-in for the transaction.
// ---------------------------------------------------------------------------

const TODAY = "2026-08-23";
const SOURCE_A = "11111111-1111-4111-8111-111111111111";
const SOURCE_B = "22222222-2222-4222-8222-222222222222";
const MODEL_ID = "00000000-0000-4000-8000-000000000001";
const VARIANT_A_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VARIANT_B_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const SOURCE_IDS = new Map([
  ["fixture-source", SOURCE_A],
  ["fixture-source-b", SOURCE_B],
]);

type VariantInsert = InferInsertModel<typeof vehicleVariants>;

/**
 * Two visibly synthetic variants. The point is the mechanism — mixed
 * numeric/bigint/enum columns, two different sources on one row, an
 * evidence-backed null — and none of these numbers describes a real vehicle.
 */
const ENTITIES: readonly SeedEntity<VariantInsert>[] = [
  {
    key: "fixture-variant-a",
    identity: {
      slug: "fixture-variant-a",
      modelId: MODEL_ID,
      name: "Fixture Variant A",
      fuelType: "petrol",
      transmission: "manual",
      emissionNorm: "bs6_phase2",
    },
    facts: {
      realWorldEfficiencyCity: {
        value: "12",
        source: "fixture-source",
        verifiedAt: "2026-01-15",
        confidence: "high",
        sourceUrl: "https://fixture.invalid/a",
      },
      exShowroomPaise: {
        value: 100_000_00,
        source: "fixture-source-b",
        verifiedAt: "2026-02-01",
      },
    },
  },
  {
    key: "fixture-variant-b",
    identity: {
      slug: "fixture-variant-b",
      modelId: MODEL_ID,
      name: "Fixture Variant B",
      fuelType: "electric",
      transmission: "single_speed",
      emissionNorm: "zero_emission",
    },
    facts: {
      realWorldRangeKm: {
        value: null,
        source: "fixture-source",
        verifiedAt: "2026-02-01",
        confidence: "low",
        excerpt: "Fixture source publishes no range figure for this configuration.",
      },
    },
  },
];

/** A row as the entity `select` projection hands it back. */
function liveVariant(
  key: string,
  id: string,
  columns: Record<string, unknown>,
): Record<string, unknown> {
  return { id, slug: key, ...columns };
}

/** A `fact_provenance` row as the importer's projection reads it. */
function liveFact(
  entityId: string,
  field: string,
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    entityId,
    field,
    sourceId: SOURCE_A,
    sourceUrl: null,
    excerpt: null,
    confidence: "medium",
    verifiedAt: "2026-01-15",
    ...overrides,
  };
}

const A_FACTS = [
  liveFact(VARIANT_A_ID, "real_world_efficiency_city", {
    confidence: "high",
    sourceUrl: "https://fixture.invalid/a",
  }),
  liveFact(VARIANT_A_ID, "ex_showroom_paise", {
    sourceId: SOURCE_B,
    verifiedAt: "2026-02-01",
  }),
];

const B_FACTS = [
  liveFact(VARIANT_B_ID, "real_world_range_km", {
    confidence: "low",
    verifiedAt: "2026-02-01",
    excerpt: "Fixture source publishes no range figure for this configuration.",
  }),
];

/** The state a completed first import leaves behind. */
const SEEDED_TABLES = {
  vehicle_variants: [
    liveVariant("fixture-variant-a", VARIANT_A_ID, {
      modelId: MODEL_ID,
      name: "Fixture Variant A",
      fuelType: "petrol",
      transmission: "manual",
      emissionNorm: "bs6_phase2",
      // Postgres pads numeric(6,2); the seed authored "12".
      realWorldEfficiencyCity: "12.00",
      exShowroomPaise: 10_000_000,
    }),
    liveVariant("fixture-variant-b", VARIANT_B_ID, {
      modelId: MODEL_ID,
      name: "Fixture Variant B",
      fuelType: "electric",
      transmission: "single_speed",
      emissionNorm: "zero_emission",
      realWorldRangeKm: null,
    }),
  ],
  fact_provenance: [...A_FACTS, ...B_FACTS],
};

function specFor(rows: readonly SeedEntity<VariantInsert>[] = ENTITIES) {
  return {
    table: vehicleVariants,
    keyColumn: vehicleVariants.slug,
    rows,
    touch: { updatedAt: new Date("2026-08-23T00:00:00Z") },
    sourceIds: SOURCE_IDS,
    today: TODAY,
  };
}

describe("importEntities — first import", () => {
  it("writes the rows, then a provenance row per fact", async () => {
    const tx = new FakeTx({ ids: [VARIANT_A_ID, VARIANT_B_ID] });

    const counts = await importEntities(tx.asSeedTx(), specFor());

    expect(counts).toEqual({
      inserted: 2,
      updated: 0,
      unchanged: 0,
      provenance: { recorded: 3, superseded: 0, unchanged: 0 },
    });
    expect(tx.log).toEqual([
      "select:vehicle_variants",
      "insert:vehicle_variants",
      "select:fact_provenance",
      "insert:fact_provenance",
      "insert:fact_provenance",
    ]);
  });

  it("attributes each fact to its own source, under the SQL column name", async () => {
    const tx = new FakeTx({ ids: [VARIANT_A_ID, VARIANT_B_ID] });
    await importEntities(tx.asSeedTx(), specFor());

    expect(tx.rowsWrittenTo("fact_provenance")).toEqual([
      {
        entityTable: "vehicle_variants",
        entityId: VARIANT_A_ID,
        field: "real_world_efficiency_city",
        sourceId: SOURCE_A,
        sourceUrl: "https://fixture.invalid/a",
        excerpt: null,
        confidence: "high",
        verifiedAt: "2026-01-15",
        meta: null,
      },
      {
        entityTable: "vehicle_variants",
        entityId: VARIANT_A_ID,
        field: "ex_showroom_paise",
        sourceId: SOURCE_B,
        sourceUrl: null,
        excerpt: null,
        confidence: "medium",
        verifiedAt: "2026-02-01",
        meta: null,
      },
      {
        entityTable: "vehicle_variants",
        entityId: VARIANT_B_ID,
        field: "real_world_range_km",
        sourceId: SOURCE_A,
        sourceUrl: null,
        excerpt: "Fixture source publishes no range figure for this configuration.",
        confidence: "low",
        verifiedAt: "2026-02-01",
        meta: null,
      },
    ]);
  });

  it("uses the entity ids RETURNING gave back, not the order values were supplied in", async () => {
    // Postgres is free to return inserted rows in any order, so the importer
    // reads the key back alongside the id. Hand them back reversed and the
    // provenance must still land on the right entity.
    const tx = new FakeTx({ ids: [VARIANT_A_ID, VARIANT_B_ID] });
    await importEntities(tx.asSeedTx(), specFor([ENTITIES[1], ENTITIES[0]]));

    const byField = new Map(
      tx.rowsWrittenTo("fact_provenance").map((row) => [row.field, row.entityId]),
    );
    expect(byField.get("real_world_range_km")).toBe(VARIANT_A_ID);
    expect(byField.get("real_world_efficiency_city")).toBe(VARIANT_B_ID);
  });

  it("merges fact values into the row it inserts, alongside identity and touch", async () => {
    const tx = new FakeTx({ ids: [VARIANT_A_ID, VARIANT_B_ID] });
    await importEntities(tx.asSeedTx(), specFor());

    expect(tx.rowsWrittenTo("vehicle_variants")[0]).toEqual({
      slug: "fixture-variant-a",
      modelId: MODEL_ID,
      name: "Fixture Variant A",
      fuelType: "petrol",
      transmission: "manual",
      emissionNorm: "bs6_phase2",
      realWorldEfficiencyCity: "12",
      exShowroomPaise: 10_000_000,
      updatedAt: new Date("2026-08-23T00:00:00Z"),
    });
  });

  it("writes no change log for a row that did not exist before", async () => {
    const tx = new FakeTx({ ids: [VARIANT_A_ID, VARIANT_B_ID] });
    await importEntities(tx.asSeedTx(), specFor());

    // Every column of a fresh import would bury the changes that matter.
    expect(tx.log).not.toContain("insert:data_change_log");
  });
});

describe("importEntities — re-run", () => {
  it("writes nothing at all: the regression that matters", async () => {
    const tx = new FakeTx({ tables: SEEDED_TABLES });

    const counts = await importEntities(tx.asSeedTx(), specFor());

    // "12" authored against "12.00" read back must not count as a change. A
    // spurious update would supersede provenance on every run, turning an
    // idempotent seed into an audit-log flood.
    expect(counts).toEqual({
      inserted: 0,
      updated: 0,
      unchanged: 2,
      provenance: { recorded: 0, superseded: 0, unchanged: 3 },
    });
    expect(tx.log).toEqual(["select:vehicle_variants", "select:fact_provenance"]);
  });

  it("ignores columns the seed file never authored", async () => {
    const tx = new FakeTx({
      tables: {
        ...SEEDED_TABLES,
        vehicle_variants: SEEDED_TABLES.vehicle_variants.map((row) => ({
          ...row,
          dataQualityScore: 71,
          updatedAt: new Date("2020-01-01T00:00:00Z"),
        })),
      },
    });

    const counts = await importEntities(tx.asSeedTx(), specFor());
    expect(counts.updated).toBe(0);
  });
});

describe("importEntities — a changed fact", () => {
  const changed: readonly SeedEntity<VariantInsert>[] = [
    {
      ...ENTITIES[0],
      facts: {
        ...ENTITIES[0].facts,
        realWorldEfficiencyCity: {
          value: "13.5",
          source: "fixture-source",
          verifiedAt: "2026-08-01",
          confidence: "high",
          sourceUrl: "https://fixture.invalid/a",
        },
      },
    },
    ENTITIES[1],
  ];

  it("supersedes the old provenance BEFORE inserting the new one", async () => {
    const tx = new FakeTx({ tables: SEEDED_TABLES });

    const counts = await importEntities(tx.asSeedTx(), specFor(changed));

    // `fact_provenance_current_key` is unique over (entity_table, entity_id,
    // field) WHERE superseded_at IS NULL. Insert-then-supersede violates it,
    // and because the whole seed run shares one transaction it would take every
    // other module down with it.
    expect(tx.log).toEqual([
      "select:vehicle_variants",
      "update:vehicle_variants",
      "select:fact_provenance",
      "update:fact_provenance",
      "insert:fact_provenance",
      "insert:data_change_log",
    ]);
    // The one adjacency that is load-bearing: supersede immediately precedes
    // insert on fact_provenance, per entity.
    const prov = tx.log.filter((call) => call.endsWith(":fact_provenance"));
    expect(prov).toEqual(["select", "update", "insert"].map((op) => `${op}:fact_provenance`));
    expect(counts).toEqual({
      inserted: 0,
      updated: 1,
      unchanged: 1,
      provenance: { recorded: 1, superseded: 1, unchanged: 2 },
    });
  });

  it("interleaves supersede and insert per entity rather than batching the table", async () => {
    const bothChanged: readonly SeedEntity<VariantInsert>[] = [
      changed[0],
      {
        ...ENTITIES[1],
        facts: {
          realWorldRangeKm: {
            value: null,
            source: "fixture-source-b",
            verifiedAt: "2026-02-01",
            confidence: "low",
            excerpt: "Fixture source publishes no range figure for this configuration.",
          },
        },
      },
    ];

    const tx = new FakeTx({ tables: SEEDED_TABLES });
    await importEntities(tx.asSeedTx(), specFor(bothChanged));

    // Two supersedes followed by two inserts would be the natural batching, and
    // the second insert would collide with the still-current row of the first
    // entity. Per-entity ordering is what keeps that from happening.
    expect(tx.log.filter((call) => call.endsWith(":fact_provenance"))).toEqual([
      "select:fact_provenance",
      "update:fact_provenance",
      "insert:fact_provenance",
      "update:fact_provenance",
      "insert:fact_provenance",
    ]);
  });

  it("stamps supersededAt rather than rewriting or deleting the old row", async () => {
    const tx = new FakeTx({ tables: SEEDED_TABLES });
    await importEntities(tx.asSeedTx(), specFor(changed));

    // The row IS the history. An UPDATE that changed source_id in place, or a
    // DELETE, would destroy the audit trail the product's defensibility rests
    // on — so the only column an update may touch is superseded_at.
    const patches = tx.updatesTo("fact_provenance");
    expect(patches).toHaveLength(1);
    expect(Object.keys(patches[0])).toEqual(["supersededAt"]);
    expect(patches[0].supersededAt).toBeInstanceOf(Date);
  });

  it("logs the field change under its SQL column name, with old and new values", async () => {
    const tx = new FakeTx({ tables: SEEDED_TABLES });
    await importEntities(tx.asSeedTx(), specFor(changed));

    expect(tx.rowsWrittenTo("data_change_log")).toEqual([
      {
        entityTable: "vehicle_variants",
        entityId: VARIANT_A_ID,
        field: "real_world_efficiency_city",
        oldValue: "12.00",
        newValue: "13.5",
        changeSource: "seed_import",
      },
    ]);
  });

  it("honours changeLog: false", async () => {
    const tx = new FakeTx({ tables: SEEDED_TABLES });
    await importEntities(tx.asSeedTx(), { ...specFor(changed), changeLog: false });

    expect(tx.log).not.toContain("insert:data_change_log");
  });
});

describe("importEntities — provenance moves independently of the row", () => {
  it("re-records a fact re-verified against a better source, leaving the row alone", async () => {
    const tx = new FakeTx({ tables: SEEDED_TABLES });

    const reVerified: readonly SeedEntity<VariantInsert>[] = [
      {
        ...ENTITIES[0],
        facts: {
          ...ENTITIES[0].facts,
          realWorldEfficiencyCity: {
            // Same value, better evidence: confidence and date moved.
            value: "12",
            source: "fixture-source",
            verifiedAt: "2026-08-20",
            confidence: "high",
            sourceUrl: "https://fixture.invalid/a",
          },
        },
      },
      ENTITIES[1],
    ];

    const counts = await importEntities(tx.asSeedTx(), specFor(reVerified));

    expect(counts.updated).toBe(0);
    expect(counts.unchanged).toBe(2);
    expect(counts.provenance).toEqual({ recorded: 1, superseded: 1, unchanged: 2 });
    expect(tx.log).not.toContain("update:vehicle_variants");
  });

  it("records a fact newly added to a row that already has others", async () => {
    const tx = new FakeTx({
      tables: {
        ...SEEDED_TABLES,
        fact_provenance: [A_FACTS[0], ...B_FACTS],
      },
    });

    const counts = await importEntities(tx.asSeedTx(), specFor());

    expect(counts.provenance).toEqual({ recorded: 1, superseded: 0, unchanged: 2 });
    expect(tx.rowsWrittenTo("fact_provenance")[0].field).toBe("ex_showroom_paise");
  });

  it("leaves a hand-curated fact the seed no longer mentions current", async () => {
    const tx = new FakeTx({
      tables: {
        ...SEEDED_TABLES,
        fact_provenance: [
          ...SEEDED_TABLES.fact_provenance,
          liveFact(VARIANT_A_ID, "curated_by_hand", { confidence: "high" }),
        ],
      },
    });

    const counts = await importEntities(tx.asSeedTx(), specFor());

    // A seed file is a floor, not a mirror. Trimming one must not erase
    // evidence somebody curated by hand.
    expect(counts.provenance).toEqual({ recorded: 0, superseded: 0, unchanged: 3 });
    expect(tx.log).not.toContain("update:fact_provenance");
  });
});

describe("importEntities — failure modes", () => {
  it("refuses a seed file that names a column the table does not have", async () => {
    const tx = new FakeTx({ ids: [VARIANT_A_ID] });
    const bogus = [
      {
        key: "fixture-variant-x",
        identity: { slug: "fixture-variant-x" },
        facts: {
          madeUpColumn: { value: 1, source: "fixture-source", verifiedAt: "2026-01-01" },
        },
      },
    ] as unknown as readonly SeedEntity<VariantInsert>[];

    await expect(importEntities(tx.asSeedTx(), specFor(bogus))).rejects.toThrow(
      /references unknown column "madeUpColumn"/,
    );
    // It fails before writing anything, not halfway through.
    expect(tx.log).toEqual([]);
  });

  it("names the entity and column when a source slug is not in the sources table", async () => {
    const tx = new FakeTx({ ids: [VARIANT_A_ID, VARIANT_B_ID] });

    await expect(
      importEntities(tx.asSeedTx(), { ...specFor(), sourceIds: new Map() }),
    ).rejects.toThrow(
      /Unknown source slug "fixture-source" on vehicle_variants\.real_world_efficiency_city \(fixture-variant-a\)/,
    );
  });

  it("rejects a rupee float in a paise column before touching the database", async () => {
    const tx = new FakeTx({ ids: [VARIANT_A_ID] });
    const rupees = [
      {
        key: "fixture-variant-y",
        identity: { slug: "fixture-variant-y" },
        facts: {
          exShowroomPaise: {
            value: 123456.78,
            source: "fixture-source",
            verifiedAt: "2026-01-01",
          },
        },
      },
    ] as unknown as readonly SeedEntity<VariantInsert>[];

    await expect(importEntities(tx.asSeedTx(), specFor(rupees))).rejects.toThrow(
      /money is paise as a safe integer/,
    );
    expect(tx.log).toEqual([]);
  });

  it("does nothing, quietly, for an empty seed file", async () => {
    const tx = new FakeTx();

    const counts = await importEntities(tx.asSeedTx(), specFor([]));

    expect(counts).toEqual({
      inserted: 0,
      updated: 0,
      unchanged: 0,
      provenance: { recorded: 0, superseded: 0, unchanged: 0 },
    });
    expect(tx.log).toEqual([]);
  });
});

describe("loadSourceIds", () => {
  it("maps slug to id in one read for the whole run", async () => {
    const tx = new FakeTx({
      tables: {
        sources: [
          { slug: "fixture-source", id: SOURCE_A },
          { slug: "fixture-source-b", id: SOURCE_B },
        ],
      },
    });

    const ids = await loadSourceIds(tx.asSeedTx());

    expect(ids.get("fixture-source")).toBe(SOURCE_A);
    expect(ids.get("fixture-source-b")).toBe(SOURCE_B);
    expect(ids.get("not-a-source")).toBeUndefined();
  });

  it("is skipped when the module already resolved the ids", async () => {
    const tx = new FakeTx({ tables: SEEDED_TABLES });
    await importEntities(tx.asSeedTx(), specFor());

    expect(tx.log).not.toContain("select:sources");
  });
});
