import {
  bigint,
  date,
  index,
  integer,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { fuelType, vehicleCategory } from "./enums";
import { states } from "./geography";

/**
 * On-road price in India is ex-showroom plus state-set road tax, registration
 * and insurance — and road tax varies from roughly 6% to 20% by state, and by
 * price band and fuel within a state. A recommendation that quotes ex-showroom
 * is wrong by lakhs, and a buyer notices immediately.
 */
export const stateOnRoadFactors = pgTable(
  "state_on_road_factors",
  {
    id: uuid().primaryKey().defaultRandom(),
    stateCode: text()
      .notNull()
      .references(() => states.code, { onDelete: "cascade" }),
    fuelType: fuelType(),
    category: vehicleCategory().notNull().default("passenger"),
    /** Inclusive lower / exclusive upper bound of ex-showroom price, in paise. */
    priceBandMinPaise: bigint({ mode: "number" }).notNull().default(0),
    priceBandMaxPaise: bigint({ mode: "number" }),
    roadTaxPct: numeric({ precision: 5, scale: 2 }).notNull(),
    registrationFeePaise: bigint({ mode: "number" }).notNull().default(0),
    /** First-year insurance as a percentage of ex-showroom. */
    insurancePct: numeric({ precision: 5, scale: 2 }).notNull(),
    /** Green cess, EV subsidy and similar, negative for a rebate. */
    otherLevyPaise: bigint({ mode: "number" }).notNull().default(0),
    effectiveFrom: date().notNull(),
    notes: text(),
  },
  (t) => [
    index("state_on_road_lookup_idx").on(
      t.stateCode,
      t.category,
      t.fuelType,
      t.priceBandMinPaise,
    ),
  ],
);

/**
 * Fuel prices move daily and directly move every TCO number, so each row is
 * dated and the UI always shows the `asOf` date alongside any figure derived
 * from it. Prices in paise per litre (petrol/diesel) or per kg (CNG).
 */
export const fuelPrices = pgTable(
  "fuel_prices",
  {
    id: uuid().primaryKey().defaultRandom(),
    stateCode: text()
      .notNull()
      .references(() => states.code, { onDelete: "cascade" }),
    cityId: uuid(),
    fuelType: fuelType().notNull(),
    pricePaise: bigint({ mode: "number" }).notNull(),
    unit: text().notNull().default("litre"),
    asOf: date().notNull(),
    sourceId: uuid(),
  },
  (t) => [
    uniqueIndex("fuel_prices_key").on(t.stateCode, t.cityId, t.fuelType, t.asOf),
    index("fuel_prices_latest_idx").on(t.stateCode, t.fuelType, t.asOf),
  ],
);

/**
 * Domestic slab tariffs. EV running cost is dominated by whether the household
 * charges on a domestic slab, a separate EV meter, or public DC — the spread is
 * roughly 4x, which is larger than the spread between vehicles.
 */
export const electricityTariffs = pgTable(
  "electricity_tariffs",
  {
    id: uuid().primaryKey().defaultRandom(),
    stateCode: text()
      .notNull()
      .references(() => states.code, { onDelete: "cascade" }),
    /** domestic_slab | ev_meter | public_ac | public_dc */
    tariffKind: text().notNull(),
    /** Both null for a flat tariff with no slab structure. */
    slabMinUnits: integer(),
    slabMaxUnits: integer(),
    pricePaisePerKwh: bigint({ mode: "number" }).notNull(),
    asOf: date().notNull(),
  },
  (t) => [index("electricity_tariffs_lookup_idx").on(t.stateCode, t.tariffKind, t.asOf)],
);

/**
 * Maintenance cost by ownership year. Curves are keyed by segment and fuel
 * rather than by variant: per-variant service pricing is not published widely
 * enough to be reliable, and the segment curve is accurate enough to rank
 * vehicles against each other, which is what we actually need.
 */
export const maintenanceCurves = pgTable(
  "maintenance_curves",
  {
    id: uuid().primaryKey().defaultRandom(),
    segment: text().notNull(),
    fuelType: fuelType().notNull(),
    category: vehicleCategory().notNull().default("passenger"),
    ownershipYear: smallint().notNull(),
    /** Cost for that single year at the reference annual distance. */
    costPaise: bigint({ mode: "number" }).notNull(),
    referenceAnnualKm: integer().notNull().default(12000),
    /** Marginal cost per extra km beyond the reference, for high-usage users. */
    marginalCostPaisePerKm: bigint({ mode: "number" }).notNull().default(0),
    sourceId: uuid(),
    asOf: date().notNull(),
  },
  (t) => [
    uniqueIndex("maintenance_curves_key").on(
      t.segment,
      t.fuelType,
      t.category,
      t.ownershipYear,
      t.asOf,
    ),
  ],
);

/** Residual value as a percentage of ex-showroom, by age. */
export const resaleCurves = pgTable(
  "resale_curves",
  {
    id: uuid().primaryKey().defaultRandom(),
    segment: text().notNull(),
    fuelType: fuelType().notNull(),
    category: vehicleCategory().notNull().default("passenger"),
    ageYears: smallint().notNull(),
    residualPct: numeric({ precision: 5, scale: 2 }).notNull(),
    /** How thin the used market is — a high-residual vehicle nobody buys is not
     * actually liquid, and commercial buyers care about this more than price. */
    liquidityScore: smallint(),
    sourceId: uuid(),
    asOf: date().notNull(),
  },
  (t) => [
    uniqueIndex("resale_curves_key").on(
      t.segment,
      t.fuelType,
      t.category,
      t.ageYears,
      t.asOf,
    ),
  ],
);

/**
 * Battery replacement is the single largest uncertainty in EV ownership cost.
 * We model it as a probability-weighted expense over the horizon rather than
 * either ignoring it or assuming it always happens.
 */
export const batteryCosts = pgTable(
  "battery_costs",
  {
    id: uuid().primaryKey().defaultRandom(),
    chemistry: text().notNull(),
    pricePaisePerKwh: bigint({ mode: "number" }).notNull(),
    /** Expected annual capacity fade, used to decide whether a replacement
     * falls inside the ownership horizon at all. */
    annualDegradationPct: numeric({ precision: 4, scale: 2 }).notNull(),
    /** Capacity below which an owner typically replaces rather than tolerates. */
    replacementThresholdPct: numeric({ precision: 4, scale: 2 })
      .notNull()
      .default("70"),
    asOf: date().notNull(),
    sourceId: uuid(),
  },
  (t) => [uniqueIndex("battery_costs_key").on(t.chemistry, t.asOf)],
);

export const financeRates = pgTable(
  "finance_rates",
  {
    id: uuid().primaryKey().defaultRandom(),
    category: vehicleCategory().notNull(),
    fuelType: fuelType(),
    lenderKind: text().notNull().default("bank"),
    annualRatePct: numeric({ precision: 5, scale: 2 }).notNull(),
    typicalTenureMonths: smallint().notNull(),
    typicalDownPaymentPct: numeric({ precision: 5, scale: 2 }).notNull(),
    processingFeePct: numeric({ precision: 5, scale: 2 }).notNull().default("0"),
    asOf: date().notNull(),
  },
  (t) => [index("finance_rates_lookup_idx").on(t.category, t.fuelType, t.asOf)],
);

/**
 * Emission factors used by the well-to-wheel CO2 calculation. Kept in the
 * database rather than hardcoded so the constants carry a source and a date —
 * the grid factor in particular improves every year as renewables grow, and a
 * stale constant quietly biases every EV recommendation.
 */
export const emissionFactors = pgTable(
  "emission_factors",
  {
    id: uuid().primaryKey().defaultRandom(),
    fuelType: fuelType().notNull(),
    /** grams CO2-equivalent per litre, per kg, or per kWh. */
    gramsCo2ePerUnit: numeric({ precision: 10, scale: 2 }).notNull(),
    unit: text().notNull(),
    /** Whether the figure covers extraction and refining, or only combustion. */
    scope: text().notNull().default("well_to_wheel"),
    stateCode: text(),
    asOf: date().notNull(),
    sourceId: uuid(),
    notes: text(),
  },
  (t) => [index("emission_factors_lookup_idx").on(t.fuelType, t.stateCode, t.asOf)],
);

/** Audit trail for the scheduled refresh jobs that keep the tables above current. */
export const economicsRefreshLog = pgTable("economics_refresh_log", {
  id: uuid().primaryKey().defaultRandom(),
  tableName: text().notNull(),
  refreshedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  rowsAffected: integer().notNull().default(0),
  detail: text(),
});
