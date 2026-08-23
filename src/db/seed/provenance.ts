/**
 * The seed *file format* and every decision the provenance-aware importer makes.
 *
 * ## The format
 *
 * A seed file is a TypeScript module exporting `readonly SeedEntity<T>[]`,
 * where `T` is the table's Drizzle insert model. Not YAML, not CSV, and
 * deliberately so: the repository has no YAML or CSV parser, and a TypeScript
 * literal is checked by `pnpm typecheck` in CI, where a YAML file is checked by
 * nobody until it reaches Postgres and fails there. That is the wrong end of
 * the loop for a catalogue whose whole value is being right.
 *
 * Nothing here knows that, though. `SeedEntity` is a plain object shape and
 * every function below takes plain objects, so a YAML or CSV loader producing
 * the same shape can be bolted on later without touching the importer.
 *
 * ## Provenance is per FIELD, not per row
 *
 * A row's `identity` holds structural columns — slug, foreign keys, name,
 * lifecycle status — which describe *which* thing this is and need no source.
 * Its `facts` hold the fact-bearing columns, and each one carries its own
 * source, confidence and verification date. A variant whose price came from an
 * OEM price list yesterday and whose real-world efficiency came from an
 * owner-survey aggregate last quarter records exactly that, rather than
 * flattening both to whatever the row-level source happened to be.
 *
 * ## Why this file is where the work is
 *
 * CI runs `pnpm test` with no `DATABASE_URL`, so anything that talks to
 * Postgres is untested. Every judgement — what counts as changed, when a
 * provenance row is superseded, what a malformed seed file looks like — lives
 * here as a pure function. `importer.ts` is left holding only statements.
 */

export type ConfidenceLevel = "high" | "medium" | "low";

const CONFIDENCE_LEVELS: readonly ConfidenceLevel[] = ["high", "medium", "low"];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A JSON-ish string that means a number: "18.00", "-3", "1e5". */
const NUMERIC_TEXT = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

/** One fact plus the evidence behind it. Provenance is per FIELD, not per row. */
export type Sourced<T> = {
  value: T;
  /** `sources.slug`; the importer resolves it to `sources.id` and fails loudly if unknown. */
  source: string;
  /** ISO `YYYY-MM-DD`, matching `fact_provenance.verifiedAt`. Never defaulted to today. */
  verifiedAt: string;
  /** Omitted falls through to the column default, "medium". */
  confidence?: ConfidenceLevel;
  sourceUrl?: string;
  excerpt?: string;
  meta?: Record<string, unknown>;
};

/**
 * One row of a seed file.
 *   `identity` — structural columns (slug, modelId, name, status). No source needed.
 *   `facts`    — fact-bearing columns. Each carries its own source/confidence/verifiedAt.
 */
export type SeedEntity<TInsert> = {
  /** Natural key, matching the table's unique slug/code column. */
  key: string;
  identity: Partial<TInsert>;
  facts: { [K in keyof TInsert]?: Sourced<TInsert[K]> };
};

/** A fact lifted out of a `SeedEntity`, still keyed by the TS property name. */
export type SeedFact = { field: string; sourced: Sourced<unknown> };

export type ExistingProvenance = {
  field: string;
  sourceId: string;
  sourceUrl: string | null;
  excerpt: string | null;
  confidence: ConfidenceLevel;
  verifiedAt: string;
};

export type DesiredProvenance = ExistingProvenance & { meta?: Record<string, unknown> | null };

export type ProvenancePlan = {
  /** New current rows. */
  toInsert: DesiredProvenance[];
  /** Fields whose current row must be stamped `supersededAt` FIRST. */
  toSupersede: string[];
  unchanged: number;
};

/** A single field-level change, ready for `data_change_log`. */
export type FieldChange = { field: string; oldValue: unknown; newValue: unknown };

// ---------------------------------------------------------------------------
// Value comparison
// ---------------------------------------------------------------------------

/**
 * Structural equality across the shapes Postgres actually hands back.
 *
 * This generalises the `sameNumeric` helper in `modules/cities.ts`, which
 * exists because `numeric(6,2)` comes back zero-padded: authoring `"18"` and
 * reading `"18.00"` are the same fact, and a `===` comparator would report an
 * update on every run forever. For a provenance-aware module that is worse than
 * noisy — every spurious update supersedes a provenance row, turning an
 * idempotent seed into an audit-log flood.
 *
 * Deliberately *not* used to compare provenance evidence: `sourceUrl` and
 * `excerpt` are text whose exact bytes matter, and are compared strictly.
 *
 * Known limitation: it works on values, not column types, so two *text* values
 * that happen to look numeric — `"1.10"` and `"1.1"` — compare equal and a
 * change between them would go unwritten. No text column in the catalogue holds
 * a decimal today (slugs, names, trim levels, units, chemistries), so this is
 * recorded rather than defended against. Adding a column-type-aware comparator
 * is the fix if one ever does.
 */
export function sameColumnValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;

  // Absent and explicitly-null unify: Drizzle omits `undefined` on insert, and
  // Postgres reads the column back as `null`.
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;

  if (a instanceof Date || b instanceof Date) {
    const ta = toEpoch(a);
    const tb = toEpoch(b);
    return ta !== null && tb !== null && ta === tb;
  }

  if (isNumericValue(a) && isNumericValue(b)) return Number(a) === Number(b);

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    // Order is significant: a jsonb array is a list, and reordering
    // `knownAdvantages` is a real editorial change.
    return a.every((item, i) => sameColumnValue(item, b[i]));
  }

  if (isPlainObject(a) && isPlainObject(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    return keysA.every(
      (key) => Object.prototype.hasOwnProperty.call(b, key) && sameColumnValue(a[key], b[key]),
    );
  }

  return false;
}

function toEpoch(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  if (typeof value === "number") return value;
  return null;
}

function isNumericValue(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "bigint") return true;
  // `""` and `"  "` must not slip through as 0.
  return typeof value === "string" && NUMERIC_TEXT.test(value.trim()) && value.trim() !== "";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Seed file -> row + facts
// ---------------------------------------------------------------------------

export type SplitEntity<TInsert> = {
  values: Partial<TInsert>;
  facts: SeedFact[];
};

export type SplitOptions = {
  /** `YYYY-MM-DD`; overridable so the "not in the future" check is testable. */
  today?: string;
};

/**
 * Split a `SeedEntity` into the row to write and the provenance to record,
 * validating the seed file on the way through.
 *
 * Validation throws rather than repairing. A seed file is authored by a human
 * who can fix it; guessing on their behalf is how invented data gets into a
 * catalogue that claims every number is attributable.
 */
export function splitEntity<TInsert extends Record<string, unknown>>(
  entity: SeedEntity<TInsert>,
  options: SplitOptions = {},
): SplitEntity<TInsert> {
  const key = entity.key;
  if (typeof key !== "string" || key.trim() === "") {
    throw new Error("Seed entity is missing a natural key.");
  }

  const today = options.today ?? todayIso();
  const values: Partial<TInsert> = { ...entity.identity };
  const facts: SeedFact[] = [];

  for (const [field, sourced] of Object.entries(entity.facts) as [string, Sourced<unknown>][]) {
    if (sourced === undefined) continue;

    if (Object.prototype.hasOwnProperty.call(entity.identity, field)) {
      throw new Error(
        `Seed entity "${key}": "${field}" appears in both identity and facts. ` +
          `A column is either structural or sourced, not both.`,
      );
    }

    validateSourced(key, field, sourced, today);
    (values as Record<string, unknown>)[field] = sourced.value;
    facts.push({ field, sourced });
  }

  return { values, facts };
}

function validateSourced(key: string, field: string, sourced: Sourced<unknown>, today: string) {
  const where = `Seed entity "${key}", field "${field}"`;

  if (sourced === null || typeof sourced !== "object") {
    throw new Error(`${where}: a fact must be an object { value, source, verifiedAt }.`);
  }

  if (!Object.prototype.hasOwnProperty.call(sourced, "value") || sourced.value === undefined) {
    throw new Error(
      `${where}: has no value. Use \`value: null\` to record a fact as known-absent; ` +
        `omit the field entirely if it was never looked up.`,
    );
  }

  if (typeof sourced.source !== "string" || sourced.source.trim() === "") {
    throw new Error(`${where}: needs a non-empty \`source\` (a \`sources.slug\`).`);
  }

  if (typeof sourced.verifiedAt !== "string" || !ISO_DATE.test(sourced.verifiedAt)) {
    throw new Error(
      `${where}: \`verifiedAt\` must be an ISO date (YYYY-MM-DD), got ` +
        `${JSON.stringify(sourced.verifiedAt)}. It is never defaulted — a date nobody ` +
        `supplied would fabricate a verification that never happened.`,
    );
  }

  if (!isRealDate(sourced.verifiedAt)) {
    throw new Error(`${where}: \`verifiedAt\` "${sourced.verifiedAt}" is not a real date.`);
  }

  if (sourced.verifiedAt > today) {
    throw new Error(
      `${where}: \`verifiedAt\` "${sourced.verifiedAt}" is in the future (today is ${today}).`,
    );
  }

  if (sourced.confidence !== undefined && !CONFIDENCE_LEVELS.includes(sourced.confidence)) {
    throw new Error(
      `${where}: \`confidence\` must be one of ${CONFIDENCE_LEVELS.join(" | ")}, got ` +
        `${JSON.stringify(sourced.confidence)}.`,
    );
  }

  // Money is paise stored as bigint. A rupee float here is the documented way
  // this project gets a wrong number, and it compounds over a ten-year horizon.
  if (field.endsWith("Paise") && sourced.value !== null) {
    if (typeof sourced.value !== "number" || !Number.isSafeInteger(sourced.value)) {
      throw new Error(
        `${where}: money is paise as a safe integer, got ${JSON.stringify(sourced.value)}. ` +
          `₹1,23,456 is 12345600, not 123456.78.`,
      );
    }
  }
}

function isRealDate(iso: string): boolean {
  const parsed = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === iso;
}

export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Facts -> fact_provenance rows
// ---------------------------------------------------------------------------

export type BuildProvenanceOptions = {
  entityKey: string;
  /** SQL table name, e.g. `vehicle_variants`. Only used in error messages here. */
  entityTable: string;
  /** TS property name -> SQL column name. `fact_provenance.field` holds the SQL name. */
  sqlFieldName: (field: string) => string;
  /** `sources.slug` -> `sources.id`. */
  sourceId: (slug: string) => string | undefined;
};

/**
 * Turn the facts of one entity into the `fact_provenance` rows that describe
 * them, resolving source slugs and translating property names to SQL column
 * names.
 *
 * `field` stores the **snake_case SQL column name**, matching `entityTable`
 * holding the SQL table name. Both halves of the key have to agree, and the
 * SQL name is the one the validation job and the `sources` block of every API
 * response can join on without knowing the Drizzle export names.
 */
export function buildProvenanceRows(
  facts: readonly SeedFact[],
  options: BuildProvenanceOptions,
): DesiredProvenance[] {
  return facts.map(({ field, sourced }) => {
    const column = options.sqlFieldName(field);
    const sourceId = options.sourceId(sourced.source);
    if (sourceId === undefined) {
      throw new Error(
        `Unknown source slug "${sourced.source}" on ${options.entityTable}.${column} ` +
          `(${options.entityKey}) — add it to SOURCE_SEED_ROWS.`,
      );
    }
    return {
      field: column,
      sourceId,
      sourceUrl: sourced.sourceUrl ?? null,
      excerpt: sourced.excerpt ?? null,
      confidence: sourced.confidence ?? "medium",
      verifiedAt: sourced.verifiedAt,
      meta: sourced.meta ?? null,
    };
  });
}

/**
 * Diff the provenance we want against the provenance that is currently live.
 *
 * Three rules hold this together:
 *
 * 1. **A provenance row is never updated and never deleted.** The row *is* the
 *    history. `onConflictDoUpdate` with `targetWhere: superseded_at is null`
 *    compiles, reads tidily, and silently destroys the audit trail that the
 *    product's defensibility rests on.
 * 2. **A changed fact supersedes then inserts, in that order.** The partial
 *    unique index `fact_provenance_current_key` permits exactly one current row
 *    per `(entityTable, entityId, field)`, so inserting first is a constraint
 *    violation — and since the whole seed run shares one transaction, that
 *    violation takes every other module down with it.
 * 3. **Fields the seed no longer mentions are left current.** Same floor-not-
 *    mirror rule `planSeed` documents: trimming a seed file must not erase
 *    curated evidence.
 *
 * `meta` is deliberately outside the comparison. It is annotation — a parser
 * version, a note to a reviewer — not evidence, and changing it should not
 * cost a supersession.
 */
export function planProvenance(
  desired: readonly DesiredProvenance[],
  existing: readonly ExistingProvenance[],
): ProvenancePlan {
  const seen = new Set<string>();
  for (const row of desired) {
    if (seen.has(row.field)) {
      throw new Error(`Duplicate provenance field: ${row.field}`);
    }
    seen.add(row.field);
  }

  const current = new Map<string, ExistingProvenance>();
  for (const row of existing) current.set(row.field, row);

  const plan: ProvenancePlan = { toInsert: [], toSupersede: [], unchanged: 0 };
  for (const row of desired) {
    const live = current.get(row.field);
    if (live === undefined) {
      plan.toInsert.push(row);
    } else if (sameEvidence(row, live)) {
      plan.unchanged += 1;
    } else {
      plan.toSupersede.push(row.field);
      plan.toInsert.push(row);
    }
  }
  return plan;
}

function sameEvidence(desired: DesiredProvenance, existing: ExistingProvenance): boolean {
  return (
    desired.sourceId === existing.sourceId &&
    (desired.sourceUrl ?? null) === (existing.sourceUrl ?? null) &&
    (desired.excerpt ?? null) === (existing.excerpt ?? null) &&
    desired.confidence === existing.confidence &&
    desired.verifiedAt === existing.verifiedAt
  );
}

// ---------------------------------------------------------------------------
// Row diffing
// ---------------------------------------------------------------------------

/**
 * Compare only the columns the seed file actually authored.
 *
 * Comparing whole rows would drag `createdAt`, `updatedAt` and
 * `dataQualityScore` into the diff, so nothing would ever be `unchanged` and
 * every run would rewrite the table.
 */
export function sameAuthoredColumns(
  desired: Record<string, unknown>,
  existing: Record<string, unknown>,
): boolean {
  return Object.keys(desired).every((column) =>
    sameColumnValue(desired[column], existing[column]),
  );
}

/**
 * The per-field deltas behind a row update, for `data_change_log`. Emitted only
 * for rows that already existed: logging every column of a freshly inserted row
 * would bury the changes that matter under the initial import.
 */
export function planFieldChanges(
  desired: Record<string, unknown>,
  existing: Record<string, unknown>,
): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const column of Object.keys(desired)) {
    if (!sameColumnValue(desired[column], existing[column])) {
      changes.push({
        field: column,
        oldValue: existing[column] ?? null,
        newValue: desired[column] ?? null,
      });
    }
  }
  return changes;
}
