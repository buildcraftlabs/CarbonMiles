import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

import { vehicleModels, vehicleVariants } from "./catalogue";
import { confidenceLevel, e20Verdict, riskLevel } from "./enums";
import { sources } from "./sources";

/**
 * E20 compatibility, scoped to either a model or a specific variant. Variant
 * scope wins when both exist: within one model, a 2019 BS-IV car and a 2024
 * BS-VI phase 2 car can have genuinely different answers.
 *
 * This table is the highest-liability data in the product. Nothing is inferred
 * here without a source, and we never contradict a published OEM position.
 */
export const e20Compatibility = pgTable(
  "e20_compatibility",
  {
    id: uuid().primaryKey().defaultRandom(),
    modelId: uuid().references(() => vehicleModels.id, { onDelete: "cascade" }),
    variantId: uuid().references(() => vehicleVariants.id, { onDelete: "cascade" }),
    /** Applies to units built from this date onward — OEMs switch mid-model-year. */
    appliesFrom: date(),
    appliesTo: date(),

    verdict: e20Verdict().notNull(),
    /** Fuel lines, gaskets, seals, aluminium components in contact with fuel. */
    materialRiskLevel: riskLevel().notNull().default("none"),
    /** Expected efficiency loss on E20 vs E10, as a range. Ethanol carries about
     * a third less energy per litre than petrol, so a drop is arithmetic, not
     * opinion; the size of it depends on how the engine is tuned. */
    mileageDeltaMinPct: numeric({ precision: 4, scale: 2 }),
    mileageDeltaMaxPct: numeric({ precision: 4, scale: 2 }),

    oemStatementUrl: text(),
    oemStatementSummary: text(),
    sourceId: uuid().references(() => sources.id, { onDelete: "restrict" }),
    confidence: confidenceLevel().notNull().default("medium"),
    /** True when the verdict comes from the BS norm rule rather than an explicit
     * OEM statement — surfaced to the user as "inferred from emission norm". */
    inferredFromNorm: boolean().notNull().default(false),

    notes: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("e20_compat_model_idx").on(t.modelId),
    uniqueIndex("e20_compat_variant_key")
      .on(t.variantId)
      .where(sql`variant_id is not null`),
  ],
);

/**
 * Guidance the advisor gives once it has a verdict: what to inspect, how often,
 * what to change. Deterministic rows selected by verdict and risk level — the
 * LLM phrases these, it does not decide them.
 */
export const e20GuidanceRules = pgTable(
  "e20_guidance_rules",
  {
    id: uuid().primaryKey().defaultRandom(),
    /** inspection | service_interval | driving_habit | component_upgrade | fuel_practice */
    kind: text().notNull(),
    appliesToVerdict: e20Verdict().notNull(),
    minRiskLevel: riskLevel().notNull().default("none"),
    /** Optional narrowing, e.g. only two-wheelers or only pre-2010 vehicles. */
    appliesToBodyTypes: jsonb().$type<string[]>().notNull().default([]),
    appliesToMaxYear: smallint(),

    title: text().notNull(),
    detail: text().notNull(),
    /** Lower sorts first; the UI shows the top few and collapses the rest. */
    priority: smallint().notNull().default(50),
    sourceId: uuid().references(() => sources.id, { onDelete: "restrict" }),
  },
  (t) => [index("e20_guidance_lookup_idx").on(t.appliesToVerdict, t.minRiskLevel, t.priority)],
);

/**
 * The knowledge base — the only place in the product that uses RAG. Vehicle
 * specifications never come from here; they come from the catalogue tables.
 *
 * Retrieval is hybrid: Postgres full-text over `searchVector` fused with cosine
 * similarity over `embedding`. With a corpus this small, lexical search alone
 * is often enough, and fusing the two keeps recall high without a second store.
 */
export const e20KbChunks = pgTable(
  "e20_kb_chunks",
  {
    id: uuid().primaryKey().defaultRandom(),
    documentSlug: text().notNull(),
    chunkIndex: smallint().notNull(),
    title: text(),
    content: text().notNull(),
    tags: jsonb().$type<string[]>().notNull().default([]),

    embedding: vector({ dimensions: 1536 }),
    embeddingModel: text(),
    embeddedAt: timestamp({ withTimezone: true }),

    sourceId: uuid().references(() => sources.id, { onDelete: "restrict" }),
    sourceUrl: text(),
    /** 0-100. Weighs a peer-reviewed study above a forum post at fusion time. */
    credibility: smallint().notNull().default(50),
    publishedAt: date(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("e20_kb_chunk_key").on(t.documentSlug, t.chunkIndex),
    index("e20_kb_fts_idx").using(
      "gin",
      sql`to_tsvector('english', coalesce(${t.title}, '') || ' ' || ${t.content})`,
    ),
    index("e20_kb_embedding_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
  ],
);
