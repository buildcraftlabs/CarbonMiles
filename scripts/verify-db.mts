/**
 * Post-migration sanity check. Confirms the things drizzle-kit cannot confirm
 * for us: that the hand-added extensions exist, that the vector column is a
 * real pgvector column rather than text, and that the hot-path indexes landed.
 *
 *   pnpm exec tsx --env-file=.env.local scripts/verify-db.mts
 */
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });

const [{ n: tableCount }] = await sql<{ n: number }[]>`
  select count(*)::int as n
  from information_schema.tables
  where table_schema = 'public'
`;

const extensions = await sql<{ extname: string }[]>`
  select extname from pg_extension
  where extname in ('vector', 'pg_trgm')
  order by extname
`;

const indexes = await sql<{ indexname: string }[]>`
  select indexname from pg_indexes
  where schemaname = 'public'
    and (indexdef ilike '%hnsw%'
         or indexdef ilike '%to_tsvector%'
         or indexname = 'vehicle_variants_candidate_idx')
  order by indexname
`;

/** The trigram and jsonb GIN indexes added alongside the seed harness. A GIN
 * index on a jsonb column is silently absent rather than wrong if it fails to
 * build, so count them rather than trusting the migration log. */
const [{ n: ginCount }] = await sql<{ n: number }[]>`
  select count(*)::int as n from pg_indexes
  where schemaname = 'public' and indexdef ilike '%using gin%'
`;

const [{ n: trgmCount }] = await sql<{ n: number }[]>`
  select count(*)::int as n from pg_indexes
  where schemaname = 'public' and indexdef ilike '%gin_trgm_ops%'
`;

const [embedding] = await sql<{ udt_name: string }[]>`
  select udt_name from information_schema.columns
  where table_name = 'e20_kb_chunks' and column_name = 'embedding'
`;

const [{ n: enumCount }] = await sql<{ n: number }[]>`
  select count(distinct t.typname)::int as n
  from pg_type t
  join pg_enum e on e.enumtypid = t.oid
`;

/** Reference geography, written by `pnpm db:seed`. Every state-keyed reference
 * table and every city foreign key depends on these rows existing. */
const [{ n: stateCount }] = await sql<{ n: number }[]>`select count(*)::int as n from states`;
const [{ n: cityCount }] = await sql<{ n: number }[]>`select count(*)::int as n from cities`;
const [{ n: orphanCities }] = await sql<{ n: number }[]>`
  select count(*)::int as n
  from cities c left join states s on s.code = c.state_code
  where s.code is null
`;

console.log(`tables:      ${tableCount}`);
console.log(`enums:       ${enumCount}`);
console.log(`extensions:  ${extensions.map((r) => r.extname).join(", ") || "NONE"}`);
console.log(`embedding:   ${embedding?.udt_name ?? "MISSING"}`);
console.log(`key indexes: ${indexes.map((r) => r.indexname).join(", ") || "NONE"}`);
console.log(`gin indexes: ${ginCount} (${trgmCount} trigram)`);
console.log(`seed:        ${stateCount} states, ${cityCount} cities, ${orphanCities} orphaned`);

await sql.end();
