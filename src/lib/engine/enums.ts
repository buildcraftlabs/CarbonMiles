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

/**
 * `body_type` is written as two blocks in the schema, and the boundary is
 * load-bearing rather than cosmetic: a private buyer is never shown a tipper,
 * and a fleet buyer asking for payload is never shown a coupe. Declaring the
 * two halves separately makes that split testable — `enums.test.ts` asserts
 * their concatenation is exactly `body_type`, in order, so a new value added to
 * the database enum must be consciously placed on one side or the other.
 */
export const PASSENGER_BODY_TYPES = [
  "hatchback",
  "sedan",
  "suv",
  "mpv",
  "coupe",
  "pickup",
  "motorcycle",
  "scooter",
  "three_wheeler_passenger",
] as const;
export type PassengerBodyType = (typeof PASSENGER_BODY_TYPES)[number];

export const COMMERCIAL_BODY_TYPES = [
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
export type CommercialBodyType = (typeof COMMERCIAL_BODY_TYPES)[number];

export const BODY_TYPES = [
  ...PASSENGER_BODY_TYPES,
  ...COMMERCIAL_BODY_TYPES,
] as const;
export type BodyType = (typeof BODY_TYPES)[number];

/** Which body types a profile of each category may be shown. */
export const BODY_TYPES_BY_CATEGORY: Record<
  VehicleCategory,
  readonly BodyType[]
> = {
  passenger: PASSENGER_BODY_TYPES,
  commercial: COMMERCIAL_BODY_TYPES,
};

export const LIFECYCLE_STATUSES = ["active", "discontinued", "upcoming"] as const;
export type LifecycleStatus = (typeof LIFECYCLE_STATUSES)[number];

/**
 * Station types, as `infra_density.type` records them. Note there is no `lpg`
 * member: LPG retail is not tracked, so LPG variants pass the network gate
 * untested rather than being excluded on absent evidence.
 */
export const STATION_TYPES = [
  "petrol",
  "diesel",
  "cng",
  "ev_ac",
  "ev_dc",
  "hydrogen",
] as const;
export type StationType = (typeof STATION_TYPES)[number];

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
