import {
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { confidenceLevel } from "./enums";
import { sources } from "./sources";
import { users } from "./users";

export const scrapeJobs = pgTable(
  "scrape_jobs",
  {
    id: uuid().primaryKey().defaultRandom(),
    sourceId: uuid()
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    /** catalogue_refresh | price_refresh | fuel_price_daily | e20_watch */
    kind: text().notNull(),
    status: text().notNull().default("queued"),
    targetUrl: text(),
    scheduledFor: timestamp({ withTimezone: true }),
    startedAt: timestamp({ withTimezone: true }),
    finishedAt: timestamp({ withTimezone: true }),
    attempts: smallint().notNull().default(0),
    recordsFound: integer().notNull().default(0),
    recordsStaged: integer().notNull().default(0),
    error: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("scrape_jobs_status_idx").on(t.status, t.scheduledFor),
    index("scrape_jobs_source_idx").on(t.sourceId, t.createdAt),
  ],
);

/**
 * Every fetched document is archived before parsing. Any published fact can
 * then be re-derived from the exact bytes it came from — which is the
 * difference between an auditable catalogue and one we merely hope is right.
 */
export const rawDocuments = pgTable(
  "raw_documents",
  {
    id: uuid().primaryKey().defaultRandom(),
    jobId: uuid().references(() => scrapeJobs.id, { onDelete: "set null" }),
    sourceId: uuid().references(() => sources.id, { onDelete: "set null" }),
    url: text(),
    contentType: text(),
    blobUrl: text().notNull(),
    contentHash: text().notNull(),
    fetchedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("raw_documents_hash_idx").on(t.contentHash)],
);

/**
 * Parsed candidate values, waiting for validation and human approval. Nothing
 * reaches the live catalogue from here without a decision recorded below.
 */
export const stagingRecords = pgTable(
  "staging_records",
  {
    id: uuid().primaryKey().defaultRandom(),
    jobId: uuid().references(() => scrapeJobs.id, { onDelete: "set null" }),
    documentId: uuid().references(() => rawDocuments.id, { onDelete: "set null" }),
    entityTable: text().notNull(),
    /** Null for a proposed new row. */
    entityId: uuid(),
    /** Natural key used to match against the live catalogue when entityId is null. */
    matchKey: text(),
    proposed: jsonb().$type<Record<string, unknown>>().notNull(),
    /** Live values at the time of staging, for the reviewer's diff view. */
    current: jsonb().$type<Record<string, unknown>>(),
    confidence: confidenceLevel().notNull().default("medium"),
    /** Validation output: range violations, cross-source disagreement, large deltas. */
    validationFlags: jsonb().$type<string[]>().notNull().default([]),
    extractedBy: text().notNull().default("parser"),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("staging_records_entity_idx").on(t.entityTable, t.entityId),
    index("staging_records_job_idx").on(t.jobId),
  ],
);

export const reviewQueue = pgTable(
  "review_queue",
  {
    id: uuid().primaryKey().defaultRandom(),
    stagingRecordId: uuid()
      .notNull()
      .references(() => stagingRecords.id, { onDelete: "cascade" }),
    /** pending | approved | rejected | auto_approved */
    status: text().notNull().default("pending"),
    priority: smallint().notNull().default(50),
    assignedTo: uuid().references(() => users.id, { onDelete: "set null" }),
    decidedBy: uuid().references(() => users.id, { onDelete: "set null" }),
    decidedAt: timestamp({ withTimezone: true }),
    decisionNote: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("review_queue_status_idx").on(t.status, t.priority, t.createdAt)],
);

/** Append-only history of what changed in the catalogue, when, and on whose say-so. */
export const dataChangeLog = pgTable(
  "data_change_log",
  {
    id: uuid().primaryKey().defaultRandom(),
    entityTable: text().notNull(),
    entityId: uuid().notNull(),
    field: text(),
    oldValue: jsonb(),
    newValue: jsonb(),
    changedBy: uuid().references(() => users.id, { onDelete: "set null" }),
    /** manual | review_approval | seed_import | refresh_job */
    changeSource: text().notNull(),
    stagingRecordId: uuid(),
    changedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("data_change_log_entity_idx").on(t.entityTable, t.entityId, t.changedAt)],
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid().primaryKey().defaultRandom(),
    actorId: uuid().references(() => users.id, { onDelete: "set null" }),
    action: text().notNull(),
    entityTable: text(),
    entityId: uuid(),
    detail: jsonb().$type<Record<string, unknown>>(),
    ip: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_log_actor_idx").on(t.actorId, t.createdAt)],
);
