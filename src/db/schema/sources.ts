import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { confidenceLevel, sourceTier } from "./enums";

/**
 * Every fact in the catalogue traces back to a row here. A source also carries
 * its own crawl permissions: the ingestion pipeline will not fetch a source
 * whose terms forbid it, which keeps the legal boundary in code rather than in
 * a policy document nobody reads.
 */
export const sources = pgTable(
  "sources",
  {
    id: uuid().primaryKey().defaultRandom(),
    slug: text().notNull(),
    name: text().notNull(),
    tier: sourceTier().notNull(),
    homepageUrl: text(),
    /** Null means "not machine-collected" — a brochure PDF, a manual entry. */
    crawlAllowed: boolean().notNull().default(false),
    crawlNotes: text(),
    lastCheckedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("sources_slug_key").on(t.slug), index("sources_tier_idx").on(t.tier)],
);

/**
 * Field-level provenance. Rather than bolting a source column onto every
 * fact-bearing column, each (table, row, field) triple gets a row here. That
 * keeps the catalogue tables readable while still making it impossible for a
 * number to reach a user without an attributable origin.
 */
export const factProvenance = pgTable(
  "fact_provenance",
  {
    id: uuid().primaryKey().defaultRandom(),
    entityTable: text().notNull(),
    entityId: uuid().notNull(),
    field: text().notNull(),
    sourceId: uuid()
      .notNull()
      .references(() => sources.id, { onDelete: "restrict" }),
    /** Deep link to the exact page/PDF the value came from. */
    sourceUrl: text(),
    /** Verbatim snippet, so a reviewer can check without refetching. */
    excerpt: text(),
    confidence: confidenceLevel().notNull().default("medium"),
    verifiedAt: date().notNull(),
    supersededAt: timestamp({ withTimezone: true }),
    meta: jsonb().$type<Record<string, unknown>>(),
  },
  (t) => [
    index("fact_provenance_entity_idx").on(t.entityTable, t.entityId),
    uniqueIndex("fact_provenance_current_key")
      .on(t.entityTable, t.entityId, t.field)
      .where(sql`superseded_at is null`),
  ],
);

/**
 * Denormalised quality roll-up per row, recomputed by the validation job.
 * Cheap to read at query time; the UI surfaces it as a confidence badge and the
 * engine uses it to break ties between otherwise equal vehicles.
 */
export const dataQuality = pgTable(
  "data_quality",
  {
    entityTable: text().notNull(),
    entityId: uuid().notNull(),
    /** 0-100. Completeness x source tier x recency. */
    score: smallint().notNull(),
    missingFields: jsonb().$type<string[]>().notNull().default([]),
    staleFields: jsonb().$type<string[]>().notNull().default([]),
    computedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("data_quality_entity_key").on(t.entityTable, t.entityId),
    index("data_quality_score_idx").on(t.score),
  ],
);
