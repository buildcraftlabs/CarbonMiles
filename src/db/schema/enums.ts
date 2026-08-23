import { pgEnum } from "drizzle-orm/pg-core";

export const vehicleCategory = pgEnum("vehicle_category", [
  "passenger",
  "commercial",
]);

export const fuelType = pgEnum("fuel_type", [
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
]);

export const bodyType = pgEnum("body_type", [
  // passenger
  "hatchback",
  "sedan",
  "suv",
  "mpv",
  "coupe",
  "pickup",
  "motorcycle",
  "scooter",
  "three_wheeler_passenger",
  // commercial
  "three_wheeler_cargo",
  "mini_truck",
  "lcv",
  "mcv",
  "hcv",
  "tipper",
  "tractor_trailer",
  "bus",
  "tempo_traveller",
]);

export const transmissionType = pgEnum("transmission_type", [
  "manual",
  "amt",
  "cvt",
  "dct",
  "torque_converter",
  "single_speed",
  "imt",
]);

export const drivetrain = pgEnum("drivetrain", ["fwd", "rwd", "awd", "4wd"]);

/** BS-VI phase 2 (April 2023 onward) is the dividing line for E20 readiness. */
export const emissionNorm = pgEnum("emission_norm", [
  "bs3",
  "bs4",
  "bs6_phase1",
  "bs6_phase2",
  "zero_emission",
]);

export const lifecycleStatus = pgEnum("lifecycle_status", [
  "active",
  "discontinued",
  "upcoming",
]);

/**
 * Source trust tiers, highest first. The ingestion pipeline refuses to publish a
 * fact whose best source sits below the tier required for that field.
 */
export const sourceTier = pgEnum("source_tier", [
  "oem",
  "government",
  "industry_body",
  "licensed_aggregator",
  "editorial",
  "community",
  "internal_estimate",
]);

export const confidenceLevel = pgEnum("confidence_level", [
  "high",
  "medium",
  "low",
]);

export const e20Verdict = pgEnum("e20_verdict", [
  /** Designed and warranted for E20 — BS-VI phase 2 era, or an explicit OEM statement. */
  "e20_compliant",
  /** Materially safe on E20 but tuned for E10; expect a small efficiency loss. */
  "e20_tolerant",
  /** OEM specifies E10 or lower; running E20 carries real material risk. */
  "e10_only",
  /** Diesel, EV, CNG-only — petrol blending does not apply. */
  "not_applicable",
  "unknown",
]);

export const riskLevel = pgEnum("risk_level", [
  "none",
  "low",
  "moderate",
  "high",
]);

export const stationType = pgEnum("station_type", [
  "petrol",
  "diesel",
  "cng",
  "ev_ac",
  "ev_dc",
  "hydrogen",
]);
