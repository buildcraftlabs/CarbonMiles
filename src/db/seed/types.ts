import type { PgTransaction } from "drizzle-orm/pg-core";
import type { PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";
import type { ExtractTablesWithRelations } from "drizzle-orm";

import type * as schema from "../schema";
import type { SeedCounts } from "./diff";

/**
 * Every module runs inside the *same* transaction, so a failure part-way
 * through leaves the database exactly as it was rather than half-seeded.
 */
export type SeedTx = PgTransaction<
  PostgresJsQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

export type SeedModule = {
  /** Stable identifier, also what `--only=` matches on. */
  name: string;
  description: string;
  run: (tx: SeedTx) => Promise<SeedCounts>;
};
