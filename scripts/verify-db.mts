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

const [embedding] = await sql<{ udt_name: string }[]>`
  select udt_name from information_schema.columns
  where table_name = 'e20_kb_chunks' and column_name = 'embedding'
`;

const [{ n: enumCount }] = await sql<{ n: number }[]>`
  select count(distinct t.typname)::int as n
  from pg_type t
  join pg_enum e on e.enumtypid = t.oid
`;

console.log(`tables:      ${tableCount}`);
console.log(`enums:       ${enumCount}`);
console.log(`extensions:  ${extensions.map((r) => r.extname).join(", ") || "NONE"}`);
console.log(`embedding:   ${embedding?.udt_name ?? "MISSING"}`);
console.log(`key indexes: ${indexes.map((r) => r.indexname).join(", ") || "NONE"}`);

await sql.end();
