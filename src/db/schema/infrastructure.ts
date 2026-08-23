import {
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

import { stationType } from "./enums";
import { cities, states } from "./geography";

/**
 * Individual stations. We keep them because density has to be computed from
 * something and because a reviewer needs to be able to check a suspicious
 * number — but the recommendation engine never queries this table directly.
 */
export const fuelStations = pgTable(
  "fuel_stations",
  {
    id: uuid().primaryKey().defaultRandom(),
    externalId: text(),
    type: stationType().notNull(),
    name: text(),
    operator: text(),
    stateCode: text().references(() => states.code, { onDelete: "set null" }),
    cityId: uuid().references(() => cities.id, { onDelete: "set null" }),
    latitude: numeric({ precision: 9, scale: 6 }),
    longitude: numeric({ precision: 9, scale: 6 }),
    /** EV only: connector standards and peak output. */
    connectorTypes: text().array(),
    maxKw: numeric({ precision: 6, scale: 2 }),
    chargerCount: smallint(),
    sourceId: uuid(),
    lastSeenAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    uniqueIndex("fuel_stations_external_key").on(t.type, t.externalId),
    index("fuel_stations_city_idx").on(t.cityId, t.type),
    index("fuel_stations_geo_idx").on(t.latitude, t.longitude),
  ],
);

/**
 * The rollup the engine actually reads. Station-level data in India is
 * incomplete and goes stale fast, so we deliberately do not promise "there are
 * 47 chargers near you" — we promise a density band, which is what a
 * five-year purchase decision actually turns on, and we label it as indicative.
 */
export const infraDensity = pgTable(
  "infra_density",
  {
    id: uuid().primaryKey().defaultRandom(),
    cityId: uuid().references(() => cities.id, { onDelete: "cascade" }),
    stateCode: text().references(() => states.code, { onDelete: "cascade" }),
    type: stationType().notNull(),

    stationCount: integer().notNull().default(0),
    perLakhPopulation: numeric({ precision: 8, scale: 3 }),
    /** 0-100 percentile against every other city we hold data for. */
    percentile: smallint(),
    /** 0-100 confidence score fed into the infrastructure sub-score. Low counts
     * from a thin source produce a low score rather than a false negative. */
    confidenceScore: smallint().notNull().default(50),
    /** Typical distance to the nearest station of this type, in km. */
    medianDistanceKm: numeric({ precision: 6, scale: 2 }),

    asOf: date().notNull(),
    computedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("infra_density_key").on(t.cityId, t.stateCode, t.type, t.asOf),
    index("infra_density_lookup_idx").on(t.cityId, t.type),
  ],
);
