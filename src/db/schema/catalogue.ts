import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import {
  bodyType,
  drivetrain,
  e20Verdict,
  emissionNorm,
  fuelType,
  lifecycleStatus,
  transmissionType,
  vehicleCategory,
} from "./enums";

export const manufacturers = pgTable(
  "manufacturers",
  {
    id: uuid().primaryKey().defaultRandom(),
    slug: text().notNull(),
    name: text().notNull(),
    country: text(),
    /** Service reach feeds the reliability sub-score; a great vehicle you cannot
     * get serviced in Nashik is not a great vehicle for someone in Nashik. */
    serviceCentreCount: integer(),
    serviceCentreCountAsOf: timestamp({ withTimezone: true }),
    logoUrl: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("manufacturers_slug_key").on(t.slug)],
);

export const vehicleModels = pgTable(
  "vehicle_models",
  {
    id: uuid().primaryKey().defaultRandom(),
    slug: text().notNull(),
    manufacturerId: uuid()
      .notNull()
      .references(() => manufacturers.id, { onDelete: "restrict" }),
    name: text().notNull(),
    category: vehicleCategory().notNull(),
    bodyType: bodyType().notNull(),
    /** Market segment label used for maintenance and resale curve lookup. */
    segment: text().notNull(),
    status: lifecycleStatus().notNull().default("active"),
    launchYear: smallint(),
    discontinuedYear: smallint(),
    generation: text(),
    /** Editorial prose, kept short. Retrieved as context for the narrative. */
    summary: text(),
    knownAdvantages: jsonb().$type<string[]>().notNull().default([]),
    knownDisadvantages: jsonb().$type<string[]>().notNull().default([]),
    commonProblems: jsonb()
      .$type<Array<{ issue: string; typicalKm?: number; severity?: string }>>()
      .notNull()
      .default([]),
    imageUrl: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("vehicle_models_slug_key").on(t.slug),
    index("vehicle_models_manufacturer_idx").on(t.manufacturerId),
    index("vehicle_models_category_body_idx").on(t.category, t.bodyType, t.segment),
  ],
);

/**
 * The workhorse table. One row per buyable configuration; this is what the
 * recommendation engine filters, scores and ranks.
 *
 * Money is stored in paise as bigint — an ex-showroom price of ₹50L is 5e9
 * paise, past int32, and float rupees would drift once compounded across a
 * ten-year TCO horizon.
 */
export const vehicleVariants = pgTable(
  "vehicle_variants",
  {
    id: uuid().primaryKey().defaultRandom(),
    slug: text().notNull(),
    modelId: uuid()
      .notNull()
      .references(() => vehicleModels.id, { onDelete: "cascade" }),
    name: text().notNull(),
    trimLevel: text(),
    status: lifecycleStatus().notNull().default("active"),

    // --- powertrain
    fuelType: fuelType().notNull(),
    transmission: transmissionType().notNull(),
    drivetrain: drivetrain(),
    emissionNorm: emissionNorm().notNull(),
    engineCc: integer(),
    powerBhp: numeric({ precision: 6, scale: 2 }),
    torqueNm: numeric({ precision: 6, scale: 2 }),
    cylinders: smallint(),
    turbocharged: boolean(),

    // --- electric / hybrid
    batteryKwh: numeric({ precision: 6, scale: 2 }),
    batteryChemistry: text(),
    claimedRangeKm: integer(),
    /** What the vehicle actually does in Indian traffic, in Indian heat, with
     * the AC on. Every TCO number is built on this, never on the claim. */
    realWorldRangeKm: integer(),
    dcChargeKw: numeric({ precision: 6, scale: 2 }),
    acChargeKw: numeric({ precision: 6, scale: 2 }),
    dcChargeMinutes10To80: smallint(),
    batteryWarrantyYears: smallint(),
    batteryWarrantyKm: integer(),

    // --- efficiency (units differ by fuel: kmpl, km/kg for CNG, km/kWh for EV)
    claimedEfficiency: numeric({ precision: 6, scale: 2 }),
    realWorldEfficiencyCity: numeric({ precision: 6, scale: 2 }),
    realWorldEfficiencyHighway: numeric({ precision: 6, scale: 2 }),
    efficiencyUnit: text(),
    fuelTankLitres: numeric({ precision: 6, scale: 2 }),
    cngTankKg: numeric({ precision: 6, scale: 2 }),

    // --- practicality
    seatingCapacity: smallint(),
    bootLitres: integer(),
    payloadKg: integer(),
    gvwKg: integer(),
    deckLengthMm: integer(),
    groundClearanceMm: smallint(),
    kerbWeightKg: integer(),

    // --- money (paise)
    exShowroomPaise: bigint({ mode: "number" }),
    /** Manufacturer service-package price where published; otherwise the
     * economics engine falls back to the segment maintenance curve. */
    scheduledServiceCost5yPaise: bigint({ mode: "number" }),

    // --- E20
    e20Verdict: e20Verdict().notNull().default("unknown"),

    // --- data hygiene
    dataQualityScore: smallint(),
    lastVerifiedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("vehicle_variants_slug_key").on(t.slug),
    index("vehicle_variants_model_idx").on(t.modelId),
    /**
     * The candidate-filter predicate. Stage 1 of the engine always narrows by
     * fuel type and price, so this partial index carries the hot path.
     */
    index("vehicle_variants_candidate_idx")
      .on(t.fuelType, t.exShowroomPaise, t.seatingCapacity)
      .where(sql`status = 'active'`),
    index("vehicle_variants_payload_idx")
      .on(t.payloadKg)
      .where(sql`status = 'active' and payload_kg is not null`),
  ],
);

/**
 * Which variants a buyer can actually take delivery of in a given state.
 * Absence of a row means "assume available" — we only record known exclusions,
 * because tracking positive availability for every state x variant pair is a
 * maintenance burden with almost no decision value.
 */
export const variantAvailability = pgTable(
  "variant_availability",
  {
    id: uuid().primaryKey().defaultRandom(),
    variantId: uuid()
      .notNull()
      .references(() => vehicleVariants.id, { onDelete: "cascade" }),
    stateCode: text().notNull(),
    available: boolean().notNull().default(true),
    note: text(),
  },
  (t) => [uniqueIndex("variant_availability_key").on(t.variantId, t.stateCode)],
);
