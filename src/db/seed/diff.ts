/**
 * The pure half of the seed harness.
 *
 * Seeding has to be re-runnable: `pnpm db:seed` on a database that is already
 * seeded must be a no-op, and on a partially-seeded one must fill only the
 * gaps. Rather than blind upserts — which report nothing useful and rewrite
 * rows that did not change — each module reads what is already there, diffs it
 * against the desired rows here, and applies only the delta.
 *
 * Keeping the diff free of database access is what makes it testable against
 * fixtures without a live Postgres.
 */

/**
 * Provenance moves independently of the rows it describes: a variant whose
 * columns are all unchanged can still have a fact re-verified against a better
 * source, and that is a write worth reporting.
 */
export type ProvenanceCounts = {
  /** New `fact_provenance` rows written. */
  recorded: number;
  /** Previously-current rows stamped `superseded_at`. */
  superseded: number;
  unchanged: number;
};

export type SeedCounts = {
  inserted: number;
  updated: number;
  unchanged: number;
  /** Present only for provenance-aware modules. */
  provenance?: ProvenanceCounts;
};

export type SeedPlan<TRow> = {
  toInsert: TRow[];
  /** Carries the desired row; the module writes it over the existing one. */
  toUpdate: TRow[];
  unchanged: TRow[];
};

/**
 * Partition desired rows against what the table already holds.
 *
 * Rows present in the database but absent from `desired` are deliberately left
 * alone. A seed file is a floor, not a mirror: deleting rows the seed no longer
 * mentions would silently destroy curated data the moment someone trims a file.
 */
export function planSeed<TRow, TExisting>(
  desired: readonly TRow[],
  existing: readonly TExisting[],
  keyOf: (row: TRow | TExisting) => string,
  matches: (desiredRow: TRow, existingRow: TExisting) => boolean,
): SeedPlan<TRow> {
  const duplicate = firstDuplicateKey(desired, keyOf);
  if (duplicate !== null) {
    throw new Error(`Duplicate seed key: ${duplicate}`);
  }

  const byKey = new Map<string, TExisting>();
  for (const row of existing) {
    byKey.set(keyOf(row), row);
  }

  const plan: SeedPlan<TRow> = { toInsert: [], toUpdate: [], unchanged: [] };
  for (const row of desired) {
    const current = byKey.get(keyOf(row));
    if (current === undefined) {
      plan.toInsert.push(row);
    } else if (matches(row, current)) {
      plan.unchanged.push(row);
    } else {
      plan.toUpdate.push(row);
    }
  }
  return plan;
}

/**
 * Row counts only. The `provenance` bucket is deliberately absent rather than
 * zeroed: a geography module has no provenance to report, and an all-zero
 * bucket would read as "checked, nothing to do".
 */
export function countsOf<TRow>(plan: SeedPlan<TRow>): SeedCounts {
  return {
    inserted: plan.toInsert.length,
    updated: plan.toUpdate.length,
    unchanged: plan.unchanged.length,
  };
}

/**
 * A seed file with two rows sharing a natural key is a data bug, not a merge
 * decision — whichever row lost the race would vanish without a trace.
 */
function firstDuplicateKey<TRow, TExisting>(
  rows: readonly TRow[],
  keyOf: (row: TRow | TExisting) => string,
): string | null {
  const seen = new Set<string>();
  for (const row of rows) {
    const key = keyOf(row);
    if (seen.has(key)) return key;
    seen.add(key);
  }
  return null;
}
