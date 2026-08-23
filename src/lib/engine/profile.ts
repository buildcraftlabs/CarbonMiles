import { z } from "zod";

import { FUEL_TYPES, TARIFF_KINDS, VEHICLE_CATEGORIES } from "./enums";

/**
 * The validated user profile — the single input to the recommendation engine.
 *
 * One schema serves three callers: the questionnaire validates against it, the
 * free-text parser is given it as a strict tool schema, and the API route
 * refuses to run the engine without it. Keeping one definition is what stops
 * the parser inventing a field the engine does not read.
 *
 * Two conventions inherited from the data model:
 *   - money is paise, as integers. Rupees as floats drift once compounded.
 *   - distances are kilometres, as declared by the user, not derived.
 */

/** ₹10 crore, in paise. Rejects a mistyped budget without rejecting a bus. */
const MAX_BUDGET_PAISE = 10_000_000_000;

const paise = (max = MAX_BUDGET_PAISE) => z.number().int().nonnegative().max(max);

export const locationSchema = z.object({
  /** Two-letter RTO code, matching `states.code`. */
  stateCode: z
    .string()
    .regex(/^[A-Z]{2}$/, "state code must be two uppercase letters, e.g. MH"),
  /** Optional: on-road tax is state-level, but fuel prices and infrastructure
   * density are city-level, and both are better answers when we have it. */
  cityId: z.uuid().optional(),
});

export const budgetSchema = z
  .object({
    /**
     * Compared against **on-road** price, not ex-showroom. Users state a budget
     * in the number they will actually hand over, and road tax alone moves that
     * by lakhs between states.
     */
    maxOnRoadPaise: paise(),
    minOnRoadPaise: paise().optional(),
  })
  .refine(
    (b) => b.minOnRoadPaise === undefined || b.minOnRoadPaise <= b.maxOnRoadPaise,
    { message: "minimum budget cannot exceed maximum", path: ["minOnRoadPaise"] },
  );

/**
 * Financing changes the ranking, not just the total: a lower sticker price at a
 * worse rate can lose. `annualRatePct` is an override — left unset, the engine
 * reads `finance_rates` for the category and fuel.
 */
export const financingSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("cash") }),
  z.object({
    mode: z.literal("loan"),
    downPaymentPct: z.number().min(0).max(100),
    tenureMonths: z.number().int().min(6).max(96),
    annualRatePct: z.number().min(0).max(40).optional(),
  }),
]);

export const usageSchema = z
  .object({
    dailyKm: z.number().int().min(0).max(2000),
    monthlyKm: z.number().int().min(0).max(60000),
    /**
     * Typical single-trip distance. Legitimately larger than `dailyKm` — a
     * 300 km run every third weekend against a 40 km daily average — so the two
     * are not cross-validated. It drives the EV range gate, not the TCO.
     */
    typicalTripKm: z.number().min(0.5).max(2000),
    /**
     * Share of distance driven in city conditions, 0–100. Stored as a share
     * rather than a "city:highway ratio" because a ratio invites the reader to
     * guess which side is which, and the efficiency columns it selects between
     * differ by 20% or more.
     */
    citySharePct: z.number().int().min(0).max(100),
  })
  .refine((u) => u.monthlyKm >= u.dailyKm, {
    message: "monthly distance cannot be less than daily distance",
    path: ["monthlyKm"],
  });

export const chargingSchema = z.object({
  /** The single biggest lever on whether an EV is the right answer. */
  homeCharging: z.boolean(),
  /** Which tariff the household actually pays; the spread across these is ~4x,
   * wider than the spread between vehicles. */
  tariffKind: z.enum(TARIFF_KINDS).default("domestic_slab"),
});

export const preferencesSchema = z.object({
  /**
   * 0 = decide on money alone, 1 = weight CO2 as heavily as cost. Feeds the
   * persona weights in stage 3; it never overrides a feasibility gate, because
   * a vehicle the user cannot refuel is not a greener choice.
   */
  environmentWeight: z.number().min(0).max(1).default(0.25),
  /** Powertrains the user has ruled out for reasons we do not model. Recorded
   * as an exclusion so the result can say the vehicle was excluded by choice. */
  excludedFuelTypes: z.array(z.enum(FUEL_TYPES)).default([]),
});

const baseProfile = z.object({
  location: locationSchema,
  budget: budgetSchema,
  usage: usageSchema,
  charging: chargingSchema,
  preferences: preferencesSchema,
  financing: financingSchema,
  /** Horizon for every TCO figure. Capped at 15 because the resale and
   * maintenance curves stop being sourceable past that. */
  ownershipYears: z.number().int().min(1).max(15),
});

export const passengerProfileSchema = baseProfile.extend({
  category: z.literal("passenger"),
  /** Seats the buyer needs, not seats they would like. Drives the hard filter. */
  passengers: z.number().int().min(1).max(9),
  /**
   * A band rather than litres. Asking a private buyer for boot volume produces
   * a confidently wrong number; asking how much they carry does not.
   */
  cargoNeed: z.enum(["light", "moderate", "heavy"]).default("light"),
});

export const commercialProfileSchema = baseProfile.extend({
  category: z.literal("commercial"),
  /** Hard filter against `vehicle_variants.payloadKg`. */
  payloadKg: z.number().int().min(1).max(40000),
  /** What the vehicle earns per km. Without it there is no margin, no payback
   * month and no ROI — which is the whole reason a commercial buyer is here. */
  revenuePaisePerKm: paise(1_000_000 /* ₹10,000/km */),
  /** Zero for an owner-driver. Excluded from the passenger branch entirely
   * rather than defaulted, because a defaulted driver cost is a fabricated one. */
  driverCostPaisePerMonth: paise(100_000_000 /* ₹10 lakh/month */),
  dutyCycle: z
    .enum(["last_mile", "urban_distribution", "intercity", "mixed"])
    .default("mixed"),
  operatingDaysPerMonth: z.number().int().min(1).max(31).default(26),
});

/**
 * Discriminated on `category` so a commercial profile cannot reach the
 * passenger scoring path, or the reverse — the two weight entirely different
 * sub-scores, and a silently mis-routed profile produces a plausible wrong
 * answer rather than an error.
 */
export const recommendationProfileSchema = z.discriminatedUnion("category", [
  passengerProfileSchema,
  commercialProfileSchema,
]);

export type Location = z.infer<typeof locationSchema>;
export type Budget = z.infer<typeof budgetSchema>;
export type Financing = z.infer<typeof financingSchema>;
export type Usage = z.infer<typeof usageSchema>;
export type Charging = z.infer<typeof chargingSchema>;
export type Preferences = z.infer<typeof preferencesSchema>;
export type PassengerProfile = z.infer<typeof passengerProfileSchema>;
export type CommercialProfile = z.infer<typeof commercialProfileSchema>;
export type RecommendationProfile = z.infer<typeof recommendationProfileSchema>;

/** Input shape before defaults are applied — what a caller must supply. */
export type RecommendationProfileInput = z.input<
  typeof recommendationProfileSchema
>;

export const isCommercial = (
  profile: RecommendationProfile,
): profile is CommercialProfile => profile.category === "commercial";

/**
 * Parse-or-throw, for callers that have already decided a failure is a bug.
 * Route handlers should use `recommendationProfileSchema.safeParse` instead and
 * return field-level errors — FR-A2 requires a partial result never be served.
 */
export function parseProfile(input: unknown): RecommendationProfile {
  return recommendationProfileSchema.parse(input);
}

/** Re-exported so callers get the category list without reaching into `enums`. */
export { VEHICLE_CATEGORIES };
