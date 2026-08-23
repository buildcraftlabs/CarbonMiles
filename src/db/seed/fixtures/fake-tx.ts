import { getTableName } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";

import type { SeedTx } from "../types";

/**
 * A stand-in for `SeedTx` that records statements instead of executing them.
 *
 * CI runs `pnpm test` with no `DATABASE_URL`, and `vitest.config.mts` says
 * nothing under test may touch Postgres. That leaves the one thing `importer.ts`
 * genuinely decides — the *order* it writes in — with no coverage at all, and
 * the order is where the traps are: supersede before insert, per entity, or the
 * partial unique index `fact_provenance_current_key` aborts the whole run.
 *
 * So this fake answers the three call shapes the importer uses and logs each
 * one. It is deliberately dumb about `where`: filters are recorded, never
 * interpreted, so a test supplies exactly the rows the real query would have
 * returned. It is not a Postgres emulator and must not grow into one — anything
 * that needs real SQL semantics belongs in `pnpm db:seed --dry-run`.
 */

export type FakeCall = {
  op: "select" | "insert" | "update";
  table: string;
  /** Rows supplied to an insert, or the `set(...)` patch of an update. */
  values?: Record<string, unknown>[];
  /** Present on updates; the importer's `where` clause, unexamined. */
  filtered?: boolean;
};

export type FakeTables = Record<string, Record<string, unknown>[]>;

export type FakeTxOptions = {
  /** Existing rows, keyed by SQL table name, addressed by TS property name. */
  tables?: FakeTables;
  /** Ids handed out by `RETURNING` on insert, in order. */
  ids?: readonly string[];
};

/**
 * Drizzle's builders are thenable at several points (`.values(...)` is awaited
 * directly for provenance, but `.values(...).returning(...)` for entities), so
 * each stage is a real promise carrying the next stage as a property.
 */
function stage<T>(rows: T[]): Promise<T[]> & Record<string, unknown> {
  return Promise.resolve(rows) as Promise<T[]> & Record<string, unknown>;
}

/** `.name` is the property key here: `casing` lives on the client, not the table. */
function project(
  row: Record<string, unknown>,
  selection: Record<string, PgColumn>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [alias, column] of Object.entries(selection)) {
    out[alias] = row[column.name];
  }
  return out;
}

export class FakeTx {
  readonly calls: FakeCall[] = [];
  private readonly tables: FakeTables;
  private readonly ids: string[];

  constructor(options: FakeTxOptions = {}) {
    this.tables = options.tables ?? {};
    this.ids = [...(options.ids ?? [])];
  }

  /** `select:vehicle_variants`, `insert:fact_provenance`, … in execution order. */
  get log(): string[] {
    return this.calls.map((call) => `${call.op}:${call.table}`);
  }

  rowsWrittenTo(table: string): Record<string, unknown>[] {
    return this.calls
      .filter((call) => call.op === "insert" && call.table === table)
      .flatMap((call) => call.values ?? []);
  }

  updatesTo(table: string): Record<string, unknown>[] {
    return this.calls
      .filter((call) => call.op === "update" && call.table === table)
      .flatMap((call) => call.values ?? []);
  }

  select(selection: Record<string, PgColumn>) {
    return {
      from: (table: PgTable) => {
        const name = getTableName(table);
        this.calls.push({ op: "select", table: name });
        const rows = (this.tables[name] ?? []).map((row) => project(row, selection));
        const result = stage(rows);
        // The importer filters the provenance read; the fake trusts the test to
        // have supplied only rows that filter would have kept.
        result.where = () => stage(rows);
        return result;
      },
    };
  }

  insert(table: PgTable) {
    const name = getTableName(table);
    return {
      values: (values: Record<string, unknown> | Record<string, unknown>[]) => {
        const rows = Array.isArray(values) ? values : [values];
        this.calls.push({ op: "insert", table: name, values: rows });
        const result = stage<Record<string, unknown>>([]);
        result.returning = (selection: Record<string, PgColumn>) =>
          stage(
            rows.map((row) => {
              const id = this.ids.shift();
              if (id === undefined) {
                throw new Error(`FakeTx ran out of ids inserting into ${name}.`);
              }
              return project({ ...row, id }, selection);
            }),
          );
        return result;
      },
    };
  }

  update(table: PgTable) {
    const name = getTableName(table);
    return {
      set: (values: Record<string, unknown>) => {
        const result = stage<Record<string, unknown>>([]);
        result.where = () => {
          this.calls.push({ op: "update", table: name, values: [values], filtered: true });
          return stage<Record<string, unknown>>([]);
        };
        return result;
      },
    };
  }

  /**
   * `runSeed` owns the single transaction for the whole run and `--dry-run`
   * unwinds by throwing out of it. A savepoint opened in here could swallow that
   * unwind, so an importer that opens one is a bug, not a style choice.
   */
  transaction(): never {
    throw new Error("A seed module must not open its own transaction.");
  }

  asSeedTx(): SeedTx {
    return this as unknown as SeedTx;
  }
}
