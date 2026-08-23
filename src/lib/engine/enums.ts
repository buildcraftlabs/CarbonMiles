/**
 * Engine-side copies of the database enumerations.
 *
 * The engine deliberately does not import from `src/db/` — it is a set of pure
 * functions that must run against fixtures with no database and no Drizzle in
 * the module graph. Re-declaring the literals here is the price of that
 * boundary; `enums.test.ts` asserts these tuples match the Drizzle enums
 * exactly, so drift fails the build rather than reaching a user.
 */

export const VEHICLE_CATEGORIES = ["passenger", "commercial"] as const;
export type VehicleCategory = (typeof VEHICLE_CATEGORIES)[number];

export const FUEL_TYPES = [
  "petrol",
  "diesel",
  "cng",
  "lpg",
  "electric",
  "hybrid_mild",
  "hybrid_strong",
  "plugin_hybrid",
  "hydrogen",
  "flex_fuel",
] as const;
export type FuelType = (typeof FUEL_TYPES)[number];

export const BODY_TYPES = [
  "hatchback",
  "sedan",
  "suv",
  "mpv",
  "coupe",
  "pickup",
  "motorcycle",
  "scooter",
  "three_wheeler_passenger",
  "three_wheeler_cargo",
  "mini_truck",
  "lcv",
  "mcv",
  "hcv",
  "tipper",
  "tractor_trailer",
  "bus",
  "tempo_traveller",
] as const;
export type BodyType = (typeof BODY_TYPES)[number];

/**
 * Not a database enum — `electricity_tariffs.tariffKind` is a text column, and
 * the set is documented in its comment rather than in the type system. It is
 * declared here because the profile has to constrain it: EV running cost is
 * dominated by which of these four the household actually pays, and a free
 * string would let a typo silently pick the wrong tariff.
 */
export const TARIFF_KINDS = [
  "domestic_slab",
  "ev_meter",
  "public_ac",
  "public_dc",
] as const;
export type TariffKind = (typeof TARIFF_KINDS)[number];
