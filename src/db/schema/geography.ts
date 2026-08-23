import {
  boolean,
  index,
  integer,
  numeric,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const states = pgTable(
  "states",
  {
    /** Two-letter RTO-style code: MH, KA, DL, TN. */
    code: text().primaryKey(),
    name: text().notNull(),
    isUnionTerritory: boolean().notNull().default(false),
    region: text(),
  },
  (t) => [uniqueIndex("states_name_key").on(t.name)],
);

export const cities = pgTable(
  "cities",
  {
    id: uuid().primaryKey().defaultRandom(),
    slug: text().notNull(),
    name: text().notNull(),
    stateCode: text()
      .notNull()
      .references(() => states.code, { onDelete: "restrict" }),
    population: integer(),
    /** Tier drives infrastructure expectations and default assumptions when a
     * user does not know their own numbers. */
    tier: integer(),
    latitude: numeric({ precision: 9, scale: 6 }),
    longitude: numeric({ precision: 9, scale: 6 }),
  },
  (t) => [
    uniqueIndex("cities_slug_key").on(t.slug),
    index("cities_state_idx").on(t.stateCode),
  ],
);
