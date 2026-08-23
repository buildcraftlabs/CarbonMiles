import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";

/**
 * Fluid Compute reuses function instances across concurrent requests, so a
 * module-scoped pool is correct here — it is shared, not per-request. Keep the
 * pool small: Neon's pooled endpoint fans out on its side, and every instance
 * we run holds its own copy of this pool.
 */
const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    "DATABASE_URL is not set. Run `vercel env pull .env.local` or add it to .env.local.",
  );
}

const globalForDb = globalThis as unknown as {
  __carbonMilesSql?: ReturnType<typeof postgres>;
};

const sql =
  globalForDb.__carbonMilesSql ??
  postgres(connectionString, {
    max: 5,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,
  });

if (process.env.NODE_ENV !== "production") {
  globalForDb.__carbonMilesSql = sql;
}

export const db = drizzle(sql, { schema, casing: "snake_case" });
export type Database = typeof db;
export { sql };
