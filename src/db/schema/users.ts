import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { vehicleVariants } from "./catalogue";

export const users = pgTable(
  "users",
  {
    id: uuid().primaryKey().defaultRandom(),
    email: text().notNull(),
    emailVerifiedAt: timestamp({ withTimezone: true }),
    name: text(),
    /** Defaults remembered across sessions so returning users skip questions. */
    defaultStateCode: text(),
    defaultCityId: uuid(),
    role: text().notNull().default("user"),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp({ withTimezone: true }),
  },
  (t) => [uniqueIndex("users_email_key").on(t.email)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    userAgent: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("sessions_token_key").on(t.tokenHash),
    index("sessions_user_idx").on(t.userId),
  ],
);

/** Only the hash is stored, so a database read cannot be replayed as a login. */
export const otpCodes = pgTable(
  "otp_codes",
  {
    id: uuid().primaryKey().defaultRandom(),
    email: text().notNull(),
    codeHash: text().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    consumedAt: timestamp({ withTimezone: true }),
    attempts: smallint().notNull().default(0),
    requestIp: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("otp_codes_email_idx").on(t.email, t.createdAt)],
);

/**
 * A recommendation run, stored whether or not the user is signed in. Guest runs
 * are keyed by anonymous id and claimed on sign-in, so a user can complete the
 * whole journey before being asked for an email.
 */
export const recommendationRuns = pgTable(
  "recommendation_runs",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid().references(() => users.id, { onDelete: "set null" }),
    anonymousId: text(),

    /** The validated profile the engine ran on, verbatim. */
    profile: jsonb().$type<Record<string, unknown>>().notNull(),
    /** Bucketed profile key used for narrative cache lookup. */
    profileBucket: text(),

    candidateCount: integer().notNull().default(0),
    /** Ranked variant ids with their full score breakdown, so a run is
     * reproducible and auditable long after the catalogue has moved on. */
    results: jsonb().$type<Record<string, unknown>[]>().notNull().default([]),
    assumptions: jsonb().$type<Record<string, unknown>>(),
    narrative: text(),
    /** True when the number-validation guard rejected the model output and the
     * deterministic template was served instead. */
    narrativeFallback: boolean().notNull().default(false),

    engineVersion: text().notNull(),
    latencyMs: integer(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("recommendation_runs_user_idx").on(t.userId, t.createdAt),
    index("recommendation_runs_bucket_idx").on(t.profileBucket),
  ],
);

export const e20Assessments = pgTable(
  "e20_assessments",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid().references(() => users.id, { onDelete: "set null" }),
    anonymousId: text(),
    variantId: uuid().references(() => vehicleVariants.id, { onDelete: "set null" }),
    manufactureYear: smallint(),
    odometerKm: integer(),
    result: jsonb().$type<Record<string, unknown>>().notNull(),
    narrative: text(),
    narrativeFallback: boolean().notNull().default(false),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("e20_assessments_user_idx").on(t.userId, t.createdAt)],
);

export const savedVehicles = pgTable(
  "saved_vehicles",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    variantId: uuid()
      .notNull()
      .references(() => vehicleVariants.id, { onDelete: "cascade" }),
    note: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("saved_vehicles_key").on(t.userId, t.variantId)],
);

export const reports = pgTable(
  "reports",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid().references(() => users.id, { onDelete: "set null" }),
    anonymousId: text(),
    kind: text().notNull(),
    runId: uuid(),
    /** Unguessable path segment for the share link. */
    shareToken: text().notNull(),
    blobUrl: text(),
    sizeBytes: integer(),
    expiresAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("reports_share_token_key").on(t.shareToken),
    index("reports_user_idx").on(t.userId, t.createdAt),
  ],
);

export const feedback = pgTable(
  "feedback",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid().references(() => users.id, { onDelete: "set null" }),
    runId: uuid(),
    rating: smallint(),
    comment: text(),
    /** Which recommendation the user disagreed with, if any — the fastest
     * signal we get that the engine's weighting is wrong somewhere. */
    disputedVariantId: uuid(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("feedback_run_idx").on(t.runId)],
);

/**
 * Per-call LLM telemetry. Unit economics are the whole premise of this product,
 * so they get measured rather than assumed.
 */
export const llmCalls = pgTable(
  "llm_calls",
  {
    id: uuid().primaryKey().defaultRandom(),
    /** recommendation_narrative | profile_parse | e20_guidance | extraction */
    purpose: text().notNull(),
    model: text().notNull(),
    runId: uuid(),
    inputTokens: integer().notNull().default(0),
    outputTokens: integer().notNull().default(0),
    cachedInputTokens: integer().notNull().default(0),
    /** Micro-USD, to keep sub-cent costs in integers. */
    costMicroUsd: bigint({ mode: "number" }).notNull().default(0),
    latencyMs: integer(),
    cacheHit: boolean().notNull().default(false),
    guardRejected: boolean().notNull().default(false),
    error: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("llm_calls_purpose_idx").on(t.purpose, t.createdAt),
    index("llm_calls_created_idx").on(t.createdAt),
  ],
);
