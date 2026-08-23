import {
  and,
  eq,
  getTableColumns,
  getTableName,
  inArray,
  isNull,
  type InferInsertModel,
} from "drizzle-orm";
import { CasingCache } from "drizzle-orm/casing";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";

import { dataChangeLog } from "../schema/ingestion";
import { factProvenance, sources } from "../schema/sources";
import { countsOf, planSeed, type ProvenanceCounts, type SeedCounts } from "./diff";
import {
  buildProvenanceRows,
  planFieldChanges,
  planProvenance,
  sameAuthoredColumns,
  splitEntity,
  type SeedEntity,
  type SeedFact,
} from "./provenance";
import type { SeedTx } from "./types";

/**
 * The impure half of the provenance-aware importer: statements only.
 *
 * Every judgement this file appears to make actually lives in `provenance.ts`,
 * because CI runs the test suite with no `DATABASE_URL` and nothing that
 * touches Postgres is covered. What is left here is the ordering of writes —
 * which is not arbitrary, and the comments say why at each step.
 *
 * Note what this file never does: open a transaction. `runSeed` owns the single
 * transaction for the whole run, and `--dry-run` works by throwing out of it. A
 * nested `tx.transaction()` would create a savepoint that could swallow that
 * unwind, and catching errors in here would defeat the all-or-nothing guarantee
 * outright.
 */

/**
 * `fact_provenance.entityId` is `uuid NOT NULL`, so only tables with a uuid
 * primary key named `id` can carry provenance. `states.code` is a TEXT primary
 * key; geography is seeded by the plain harness and always will be. This
 * constraint is the type system saying so out loud rather than a runtime
 * surprise on the first text-keyed table someone points at the importer.
 */
export type ImportableTable = PgTable & { id: PgColumn };

export type ImportSpec<TTable extends ImportableTable> = {
  table: TTable;
  /** The natural-key column, e.g. `vehicleVariants.slug`. */
  keyColumn: PgColumn;
  rows: readonly SeedEntity<InferInsertModel<TTable>>[];
  /** Columns updated on every write, e.g. `{ updatedAt: new Date() }`. */
  touch?: Partial<InferInsertModel<TTable>>;
  /** Resolved once per run by the module; loaded here if omitted. */
  sourceIds?: ReadonlyMap<string, string>;
  /** Append `data_change_log` rows for updated fields. Default true. */
  changeLog?: boolean;
  /** `YYYY-MM-DD` used for the "verifiedAt is not in the future" check. */
  today?: string;
};

/**
 * `casing: "snake_case"` is configured on the *client* (and on
 * `drizzle.config.ts`), not on the tables, so a column declared without an
 * explicit SQL name reports `column.name === "realWorldEfficiencyCity"` — the
 * property key — and only converts to `real_world_efficiency_city` when
 * Drizzle renders SQL. Reading `.name` directly would therefore write a
 * camelCase `fact_provenance.field` under a snake_case `entity_table`: two
 * halves of a key that disagree, and nothing to join on.
 *
 * Reusing Drizzle's own resolver rather than writing a `toSnakeCase` here keeps
 * the two from ever drifting, and it honours a column that *was* given an
 * explicit name (`keyAsName === false`) instead of mangling it.
 */
const CASING = new CasingCache("snake_case");

/** The SQL column name, as `fact_provenance.field` and `data_change_log.field` store it. */
export function sqlColumnName(column: PgColumn): string {
  return CASING.getColumnCasing(column);
}

/** Resolve `sources.slug` -> `sources.id` once per run. */
export async function loadSourceIds(tx: SeedTx): Promise<ReadonlyMap<string, string>> {
  const rows = await tx.select({ slug: sources.slug, id: sources.id }).from(sources);
  return new Map(rows.map((row) => [row.slug, row.id]));
}

type DesiredRow = { __key: string; values: Record<string, unknown>; facts: SeedFact[] };
type ExistingRow = Record<string, unknown> & { __id: string; __key: string };

const keyOf = (row: { __key: string }) => row.__key;

export async function importEntities<TTable extends ImportableTable>(
  tx: SeedTx,
  spec: ImportSpec<TTable>,
): Promise<SeedCounts> {
  const entityTable = getTableName(spec.table);
  const columns = getTableColumns(spec.table) as unknown as Record<string, PgColumn | undefined>;

  /**
   * `fact_provenance.field` holds the snake_case SQL column name, matching
   * `entityTable` holding the SQL table name. Derived from the table rather
   * than hand-written, so it cannot drift the first time a column is renamed.
   */
  const sqlFieldName = (field: string): string =>
    sqlColumnName(sqlColumn(columns, entityTable, field));

  // --- 1. seed file -> rows to write + facts to record ----------------------
  const desired: DesiredRow[] = spec.rows.map((entity) => {
    const split = splitEntity(entity as SeedEntity<Record<string, unknown>>, {
      today: spec.today,
    });
    const values = split.values as Record<string, unknown>;
    for (const field of Object.keys(values)) sqlFieldName(field);
    return { __key: entity.key, values, facts: split.facts };
  });

  if (desired.length === 0) {
    return { inserted: 0, updated: 0, unchanged: 0, provenance: emptyProvenance() };
  }

  // --- 2. read what is already there ---------------------------------------
  // Only the columns the seed file authored, plus the key and id. Reading the
  // whole row would drag createdAt/updatedAt into the diff and nothing would
  // ever come back `unchanged`.
  const authored = new Set<string>();
  for (const row of desired) for (const field of Object.keys(row.values)) authored.add(field);

  const selection: Record<string, PgColumn> = { __id: spec.table.id, __key: spec.keyColumn };
  for (const field of authored) selection[field] = sqlColumn(columns, entityTable, field);

  // `.from()` resolves a conditional type that a bare `TTable` generic cannot
  // satisfy, so widen to `PgTable` for this one call. The projection is dynamic
  // anyway — the row shape is asserted below, and pinned by the pure tests.
  const existing = (await tx
    .select(selection)
    .from(spec.table as PgTable)) as unknown as ExistingRow[];
  const existingByKey = new Map(existing.map((row) => [row.__key, row]));

  const plan = planSeed<DesiredRow, ExistingRow>(desired, existing, keyOf, (row, current) =>
    sameAuthoredColumns(row.values, current),
  );

  // --- 3. insert, keeping the generated uuids -------------------------------
  const idByKey = new Map<string, string>();
  for (const row of existing) idByKey.set(row.__key, row.__id);

  if (plan.toInsert.length > 0) {
    const values = plan.toInsert.map((row) => ({ ...row.values, ...spec.touch }));
    // The uuid is generated by the database, so it has to come back on the
    // statement. The key comes back alongside it rather than trusting
    // `RETURNING` to preserve the order the values were supplied in.
    const returned = (await tx
      .insert(spec.table)
      .values(values as unknown as InferInsertModel<TTable>)
      .returning({ __id: spec.table.id, __key: spec.keyColumn })) as unknown as {
      __id: string;
      __key: string;
    }[];
    for (const row of returned) idByKey.set(row.__key, row.__id);
  }

  // --- 4. update changed rows ----------------------------------------------
  const changes: (typeof dataChangeLog.$inferInsert)[] = [];
  const wantChangeLog = spec.changeLog ?? true;

  for (const row of plan.toUpdate) {
    // `updatedAt` has `defaultNow()` but no on-update trigger, so `touch` is
    // what keeps it honest.
    await tx
      .update(spec.table)
      .set({ ...row.values, ...spec.touch } as unknown as Partial<InferInsertModel<TTable>>)
      .where(eq(spec.keyColumn, row.__key));

    if (!wantChangeLog) continue;
    const before = existingByKey.get(row.__key);
    const entityId = idByKey.get(row.__key);
    if (before === undefined || entityId === undefined) continue;
    for (const change of planFieldChanges(row.values, before)) {
      changes.push({
        entityTable,
        entityId,
        field: sqlFieldName(change.field),
        oldValue: change.oldValue,
        newValue: change.newValue,
        changeSource: "seed_import",
      });
    }
  }

  // --- 5. provenance, per entity, supersede-then-insert ---------------------
  // Run for *every* row, not just inserted and updated ones: a variant whose
  // columns are unchanged can still have a fact re-verified against a better
  // source, and that is exactly the write this table exists to record.
  const sourceIds = spec.sourceIds ?? (await loadSourceIds(tx));
  const entityIds = desired
    .map((row) => idByKey.get(row.__key))
    .filter((id): id is string => id !== undefined);

  const liveProvenance =
    entityIds.length === 0
      ? []
      : await tx
          .select({
            entityId: factProvenance.entityId,
            field: factProvenance.field,
            sourceId: factProvenance.sourceId,
            sourceUrl: factProvenance.sourceUrl,
            excerpt: factProvenance.excerpt,
            confidence: factProvenance.confidence,
            verifiedAt: factProvenance.verifiedAt,
          })
          .from(factProvenance)
          .where(
            and(
              eq(factProvenance.entityTable, entityTable),
              inArray(factProvenance.entityId, entityIds),
              isNull(factProvenance.supersededAt),
            ),
          );

  const liveByEntity = new Map<string, typeof liveProvenance>();
  for (const row of liveProvenance) {
    const bucket = liveByEntity.get(row.entityId);
    if (bucket === undefined) liveByEntity.set(row.entityId, [row]);
    else bucket.push(row);
  }

  const provenance = emptyProvenance();
  const supersededAt = new Date();

  for (const row of desired) {
    const entityId = idByKey.get(row.__key);
    if (entityId === undefined) {
      throw new Error(`${entityTable}: no id resolved for seed key "${row.__key}".`);
    }

    const wanted = buildProvenanceRows(row.facts, {
      entityKey: row.__key,
      entityTable,
      sqlFieldName,
      sourceId: (slug) => sourceIds.get(slug),
    });
    const provPlan = planProvenance(wanted, liveByEntity.get(entityId) ?? []);

    // Supersede FIRST. `fact_provenance_current_key` is a unique partial index
    // over (entity_table, entity_id, field) WHERE superseded_at IS NULL, so
    // inserting before retiring the old row violates it — and since the whole
    // seed run shares one transaction, that violation takes every other module
    // down with it. Batching all inserts and then all supersedes has the same
    // fault, which is why this loop is per entity rather than per table.
    if (provPlan.toSupersede.length > 0) {
      await tx
        .update(factProvenance)
        .set({ supersededAt })
        .where(
          and(
            eq(factProvenance.entityTable, entityTable),
            eq(factProvenance.entityId, entityId),
            inArray(factProvenance.field, provPlan.toSupersede),
            isNull(factProvenance.supersededAt),
          ),
        );
    }

    if (provPlan.toInsert.length > 0) {
      await tx.insert(factProvenance).values(
        provPlan.toInsert.map((fact) => ({
          entityTable,
          entityId,
          field: fact.field,
          sourceId: fact.sourceId,
          sourceUrl: fact.sourceUrl,
          excerpt: fact.excerpt,
          confidence: fact.confidence,
          verifiedAt: fact.verifiedAt,
          meta: fact.meta ?? null,
        })),
      );
    }

    provenance.recorded += provPlan.toInsert.length;
    provenance.superseded += provPlan.toSupersede.length;
    provenance.unchanged += provPlan.unchanged;
  }

  // --- 6. append-only change history ---------------------------------------
  if (changes.length > 0) await tx.insert(dataChangeLog).values(changes);

  return { ...countsOf(plan), provenance };
}

function sqlColumn(
  columns: Record<string, PgColumn | undefined>,
  entityTable: string,
  field: string,
): PgColumn {
  const column = columns[field];
  if (column === undefined) {
    throw new Error(`Seed file for ${entityTable} references unknown column "${field}".`);
  }
  return column;
}

function emptyProvenance(): ProvenanceCounts {
  return { recorded: 0, superseded: 0, unchanged: 0 };
}
