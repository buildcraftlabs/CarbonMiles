import { describe, expect, it } from "vitest";

import {
  bodyType,
  fuelType,
  vehicleCategory,
} from "@/db/schema/enums";

import { BODY_TYPES, FUEL_TYPES, VEHICLE_CATEGORIES } from "./enums";

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

  it("compares order, not just membership — the tuples are the type", () => {
    expect(FUEL_TYPES.indexOf("electric")).toBe(
      fuelType.enumValues.indexOf("electric"),
    );
  });
});
