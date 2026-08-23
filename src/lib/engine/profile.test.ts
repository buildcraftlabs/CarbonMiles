import { describe, expect, it } from "vitest";

import {
  isCommercial,
  parseProfile,
  recommendationProfileSchema,
  type RecommendationProfileInput,
} from "./profile";

/** ₹9.5 lakh on-road, the shape a questionnaire submits. */
const passengerInput = {
  category: "passenger",
  location: { stateCode: "MH" },
  budget: { maxOnRoadPaise: 95_000_000 },
  usage: { dailyKm: 40, monthlyKm: 1100, typicalTripKm: 12, citySharePct: 80 },
  charging: { homeCharging: true },
  preferences: {},
  financing: { mode: "loan", downPaymentPct: 20, tenureMonths: 60 },
  ownershipYears: 7,
  passengers: 5,
} satisfies RecommendationProfileInput;

const commercialInput = {
  category: "commercial",
  location: { stateCode: "KA", cityId: "5f5ff0dc-06e4-4b6c-9a1c-0f38e3a2b111" },
  budget: { maxOnRoadPaise: 1_200_000_000, minOnRoadPaise: 600_000_000 },
  usage: { dailyKm: 180, monthlyKm: 4700, typicalTripKm: 60, citySharePct: 55 },
  charging: { homeCharging: false, tariffKind: "public_dc" },
  preferences: { environmentWeight: 0.1, excludedFuelTypes: ["cng"] },
  financing: { mode: "cash" },
  ownershipYears: 5,
  payloadKg: 1500,
  revenuePaisePerKm: 2200,
  driverCostPaisePerMonth: 2_200_000,
} satisfies RecommendationProfileInput;

/** Drop one key, to assert the schema requires it rather than defaulting it. */
function omit<T extends object>(source: T, key: keyof T): Record<string, unknown> {
  const copy = { ...source } as Record<string, unknown>;
  delete copy[key as string];
  return copy;
}

describe("recommendationProfileSchema", () => {
  it("accepts a passenger profile and applies defaults", () => {
    const profile = parseProfile(passengerInput);

    expect(profile.category).toBe("passenger");
    expect(profile.preferences).toEqual({
      environmentWeight: 0.25,
      excludedFuelTypes: [],
    });
    expect(profile.charging.tariffKind).toBe("domestic_slab");
    expect(profile.category === "passenger" && profile.cargoNeed).toBe("light");
  });

  it("accepts a commercial profile and applies its own defaults", () => {
    const profile = parseProfile(commercialInput);

    expect(isCommercial(profile)).toBe(true);
    if (!isCommercial(profile)) throw new Error("expected a commercial profile");

    expect(profile.dutyCycle).toBe("mixed");
    expect(profile.operatingDaysPerMonth).toBe(26);
    expect(profile.payloadKg).toBe(1500);
  });

  it("routes on category — a passenger profile carries no commercial fields", () => {
    const profile = parseProfile({ ...passengerInput, payloadKg: 900 });

    expect(isCommercial(profile)).toBe(false);
    expect(profile).not.toHaveProperty("payloadKg");
  });

  it("rejects a profile with no category rather than guessing one", () => {
    expect(
      recommendationProfileSchema.safeParse(omit(passengerInput, "category"))
        .success,
    ).toBe(false);
  });

  it("requires a commercial profile to state revenue and payload", () => {
    const result = recommendationProfileSchema.safeParse(
      omit(commercialInput, "revenuePaisePerKm"),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(
      result.error.issues.some((i) => i.path.includes("revenuePaisePerKm")),
    ).toBe(true);
  });
});

describe("cross-field validation", () => {
  it("rejects a monthly distance below the daily distance", () => {
    const result = recommendationProfileSchema.safeParse({
      ...passengerInput,
      usage: { ...passengerInput.usage, dailyKm: 200, monthlyKm: 100 },
    });

    expect(result.success).toBe(false);
  });

  it("allows a typical trip longer than the daily distance", () => {
    // A 300 km run every third weekend against a 40 km daily average is real.
    const result = recommendationProfileSchema.safeParse({
      ...passengerInput,
      usage: { ...passengerInput.usage, typicalTripKm: 300 },
    });

    expect(result.success).toBe(true);
  });

  it("rejects a minimum budget above the maximum", () => {
    const result = recommendationProfileSchema.safeParse({
      ...passengerInput,
      budget: { maxOnRoadPaise: 95_000_000, minOnRoadPaise: 120_000_000 },
    });

    expect(result.success).toBe(false);
  });

  it("rejects a loan with no down payment or tenure", () => {
    const result = recommendationProfileSchema.safeParse({
      ...passengerInput,
      financing: { mode: "loan" },
    });

    expect(result.success).toBe(false);
  });
});

describe("field validation", () => {
  it.each([
    ["a lowercase state code", { location: { stateCode: "mh" } }],
    ["a three-letter state code", { location: { stateCode: "MAH" } }],
    ["a fractional budget in paise", { budget: { maxOnRoadPaise: 95_000_000.5 } }],
    ["a negative budget", { budget: { maxOnRoadPaise: -1 } }],
    ["a city share above 100", { usage: { ...passengerInput.usage, citySharePct: 120 } }],
    ["an ownership horizon past the curves", { ownershipYears: 20 }],
    ["a fuel type that does not exist", { preferences: { excludedFuelTypes: ["coal"] } }],
    ["an unknown electricity tariff", { charging: { homeCharging: true, tariffKind: "solar" } }],
    ["zero seats", { passengers: 0 }],
  ])("rejects %s", (_label, override) => {
    const result = recommendationProfileSchema.safeParse({
      ...passengerInput,
      ...override,
    });

    expect(result.success).toBe(false);
  });

  it("reports the offending field so the UI can mark it", () => {
    const result = recommendationProfileSchema.safeParse({
      ...passengerInput,
      location: { stateCode: "mh" },
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.path).toEqual(["location", "stateCode"]);
  });
});
