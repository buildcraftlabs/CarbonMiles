import { describe, expect, it } from "vitest";

import {
  bodyType,
  confidenceLevel,
  e20Verdict,
  emissionNorm,
  fuelType,
  lifecycleStatus,
  riskLevel,
  stationType,
  vehicleCategory,
} from "@/db/schema/enums";

import {
  BODY_TYPES,
  COMMERCIAL_BODY_TYPES,
  CONFIDENCE_LEVELS,
  E20_VERDICTS,
  EMISSION_NORMS,
  FUEL_TYPES,
  LIFECYCLE_STATUSES,
  PASSENGER_BODY_TYPES,
  RISK_LEVELS,
  STATION_TYPES,
  VEHICLE_CATEGORIES,
} from "./enums";

/**
 * The engine keeps its own copies of these literals so that `src/lib/engine/`
 * never imports `src/db/`. This suite is the thing that makes the duplication
 * safe: a value added to a Drizzle enum without being added here fails the
 * build, rather than becoming a variant the engine silently cannot see.
 *
 * A test may import both sides. The engine may not.
 */
describe("engine enums mirror the database enums", () => {
  it("vehicle_category", () => {
    expect(VEHICLE_CATEGORIES).toEqual(vehicleCategory.enumValues);
  });

  it("fuel_type", () => {
    expect(FUEL_TYPES).toEqual(fuelType.enumValues);
  });

  it("body_type", () => {
    expect(BODY_TYPES).toEqual(bodyType.enumValues);
  });

  it("lifecycle_status", () => {
    expect(LIFECYCLE_STATUSES).toEqual(lifecycleStatus.enumValues);
  });

  it("station_type", () => {
    expect(STATION_TYPES).toEqual(stationType.enumValues);
  });

  it("emission_norm", () => {
    expect(EMISSION_NORMS).toEqual(emissionNorm.enumValues);
  });

  it("e20_verdict", () => {
    expect(E20_VERDICTS).toEqual(e20Verdict.enumValues);
  });

  it("risk_level", () => {
    expect(RISK_LEVELS).toEqual(riskLevel.enumValues);
  });

  it("confidence_level", () => {
    expect(CONFIDENCE_LEVELS).toEqual(confidenceLevel.enumValues);
  });

  it("compares order, not just membership — the tuples are the type", () => {
    expect(FUEL_TYPES.indexOf("electric")).toBe(
      fuelType.enumValues.indexOf("electric"),
    );
  });
});

/**
 * The passenger/commercial split of `body_type` is an engine-side judgement the
 * database does not enforce — it lives in a schema comment. These assertions
 * are what keep the judgement honest: a body type added to the database enum
 * and not placed on one side of the split fails here, instead of quietly
 * becoming a variant that stage 1 filters out of every result.
 */
describe("body type split by category", () => {
  it("covers body_type exactly, in order", () => {
    expect([...PASSENGER_BODY_TYPES, ...COMMERCIAL_BODY_TYPES]).toEqual(
      bodyType.enumValues,
    );
  });

  it("assigns each body type to exactly one side", () => {
    const overlap = PASSENGER_BODY_TYPES.filter((b) =>
      (COMMERCIAL_BODY_TYPES as readonly string[]).includes(b),
    );
    expect(overlap).toEqual([]);
  });
});
