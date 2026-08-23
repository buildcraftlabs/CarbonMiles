import type {
  CandidateVariant,
  Exclusion,
  ExclusionCode,
  InfraSnapshot,
  PricedCandidate,
} from "./candidate";
import { BODY_TYPES_BY_CATEGORY, type FuelType, type StationType } from "./enums";
import {
  computeOnRoadPrice,
  selectOnRoadFactors,
  type OnRoadFactors,
} from "./on-road";
import { isCommercial, type RecommendationProfile } from "./profile";

/**
 * Stage 1 — hard filters, then fuel feasibility gates.
 *
 * Two different kinds of rejection, deliberately kept apart:
 *
 *   - a **hard filter** tests a requirement the user stated. If the datum
 *     needed to test it is missing, the variant is excluded: it cannot be shown
 *     to meet the requirement, and a family of seven must not be offered a car
 *     whose seat count we do not know.
 *   - a **feasibility gate** tests a constraint of the world around the user.
 *     If the datum is missing, the constraint is unproven, so the variant
 *     survives and an assumption is recorded. Absent evidence of a CNG network
 *     is not evidence of absence, and stage 4's infrastructure sub-score will
 *     still push a poorly-served powertrain down the ranking.
 *
 * Nothing is dropped quietly. Everything excluded comes back with a reason
 * (FR-A4), because "no results" and "no affordable results in your state" are
 * very different answers.
 */

/**
 * The thresholds the gates turn on. Exported as data so the explainability
 * payload can cite the number that excluded a vehicle rather than restating it.
 */
export const GATE_THRESHOLDS = {
  /**
   * Bottom decile of national density, or no stations at all. Below this a
   * refuelling detour stops being incidental and starts shaping every trip.
   */
  networkPercentileFloor: 10,
  /**
   * Public DC confidence below this means we hold too little evidence to
   * promise a buyer with no home charging that they can live with an EV.
   */
  evDcConfidenceFloor: 40,
  /**
   * Share of real-world range that may be consumed between charges before an
   * EV stops being practical without home charging. The 20% headroom absorbs
   * battery degradation over the ownership horizon, winter and traffic losses,
   * and the reserve nobody actually drives down to.
   */
  evRangeUtilisation: 0.8,
} as const;

/** Fuels whose usability depends on a retail network we hold density data for.
 * Petrol and diesel are ubiquitous enough that a gate would only ever fire on
 * missing data. LPG is absent from `station_type`, so it is never gated. */
const NETWORK_DEPENDENT_FUELS: Partial<Record<FuelType, StationType>> = {
  cng: "cng",
  hydrogen: "hydrogen",
};

export interface Stage1Input {
  profile: RecommendationProfile;
  /** Candidates from `vehicle_variants`, already joined to state availability. */
  candidates: readonly CandidateVariant[];
  /** Rows of `state_on_road_factors` covering the user's state. */
  onRoadFactors: readonly OnRoadFactors[];
  /** `infra_density` for the user's city, keyed by station type. */
  infra: InfraSnapshot;
  /** ISO `YYYY-MM-DD`. Passed in, never read from the clock, so a stored run
   * replays to the same result (FR-A12). */
  asOf: string;
}

export interface Stage1Result {
  candidates: PricedCandidate[];
  exclusions: Exclusion[];
  /** Where a gate could not be tested, and what was assumed instead. Flows
   * into the API response's `assumptions` alongside `data` and `sources`. */
  assumptions: string[];
}

const exclude = (
  variant: CandidateVariant,
  stage: Exclusion["stage"],
  code: ExclusionCode,
  reason: string,
): Exclusion => ({
  variantId: variant.variantId,
  name: variant.name,
  stage,
  code,
  reason,
});

const lakh = (paise: number) => (paise / 10_000_000).toFixed(2);

/**
 * Hard filters (FR-A3).
 *
 * Ordered cheapest and most fundamental first, and the first failing test wins:
 * a variant is reported against one reason, not a list. Telling a buyer their
 * ₹6L hatchback budget rules out a bus adds nothing once they have been told a
 * bus is not a passenger vehicle.
 *
 * Pricing runs last because it is the only step that has to search a table.
 */
export function applyHardFilters(
  input: Stage1Input,
): { candidates: PricedCandidate[]; exclusions: Exclusion[] } {
  const { profile, candidates, onRoadFactors, asOf } = input;
  const allowedBodyTypes = BODY_TYPES_BY_CATEGORY[profile.category];
  const excludedFuels = new Set(profile.preferences.excludedFuelTypes);

  const kept: PricedCandidate[] = [];
  const exclusions: Exclusion[] = [];
  const reject = (
    variant: CandidateVariant,
    code: ExclusionCode,
    reason: string,
  ) => exclusions.push(exclude(variant, "hard_filter", code, reason));

  for (const variant of candidates) {
    if (variant.status !== "active") {
      reject(
        variant,
        "not_active",
        variant.status === "upcoming"
          ? "Not on sale yet."
          : "No longer in production.",
      );
      continue;
    }

    if (variant.category !== profile.category) {
      reject(
        variant,
        "wrong_category",
        `A ${variant.category} vehicle, and you are shopping for a ${profile.category} one.`,
      );
      continue;
    }

    if (!(allowedBodyTypes as readonly string[]).includes(variant.bodyType)) {
      reject(
        variant,
        "body_type_wrong_category",
        `Body type ${variant.bodyType} is not offered to ${profile.category} buyers.`,
      );
      continue;
    }

    if (excludedFuels.has(variant.fuelType)) {
      reject(
        variant,
        "fuel_excluded_by_user",
        `You ruled out ${variant.fuelType} vehicles.`,
      );
      continue;
    }

    if (!variant.availableInState) {
      reject(
        variant,
        "unavailable_in_state",
        variant.availabilityNote ??
          `Not sold in ${profile.location.stateCode}.`,
      );
      continue;
    }

    if (isCommercial(profile)) {
      if (variant.payloadKg === null) {
        reject(
          variant,
          "payload_unknown",
          "Rated payload is not published, so it cannot be matched against your load.",
        );
        continue;
      }
      if (variant.payloadKg < profile.payloadKg) {
        reject(
          variant,
          "payload_below_requirement",
          `Carries ${variant.payloadKg} kg, below the ${profile.payloadKg} kg you need.`,
        );
        continue;
      }
    } else {
      if (variant.seatingCapacity === null) {
        reject(
          variant,
          "seating_unknown",
          "Seating capacity is not published, so it cannot be matched against your requirement.",
        );
        continue;
      }
      if (variant.seatingCapacity < profile.passengers) {
        reject(
          variant,
          "seating_below_requirement",
          `Seats ${variant.seatingCapacity}, below the ${profile.passengers} you need.`,
        );
        continue;
      }
    }

    if (variant.exShowroomPaise === null) {
      reject(
        variant,
        "price_unknown",
        "No published ex-showroom price, so it cannot be costed.",
      );
      continue;
    }

    const factors = selectOnRoadFactors(onRoadFactors, {
      stateCode: profile.location.stateCode,
      category: profile.category,
      fuelType: variant.fuelType,
      exShowroomPaise: variant.exShowroomPaise,
      asOf,
    });

    if (factors === null) {
      // Falling back to ex-showroom would understate the price by 10–20% and
      // admit vehicles the buyer cannot afford, so a missing rate excludes.
      reject(
        variant,
        "on_road_price_unknown",
        `No road tax and registration rates on file for ${profile.location.stateCode} in this price band, so the on-road price cannot be computed.`,
      );
      continue;
    }

    const price = computeOnRoadPrice(variant.exShowroomPaise, factors);

    if (price.onRoadPaise > profile.budget.maxOnRoadPaise) {
      reject(
        variant,
        "above_budget",
        `₹${lakh(price.onRoadPaise)} lakh on-road, above your ₹${lakh(profile.budget.maxOnRoadPaise)} lakh budget.`,
      );
      continue;
    }

    if (
      profile.budget.minOnRoadPaise !== undefined &&
      price.onRoadPaise < profile.budget.minOnRoadPaise
    ) {
      reject(
        variant,
        "below_budget_floor",
        `₹${lakh(price.onRoadPaise)} lakh on-road, below the ₹${lakh(profile.budget.minOnRoadPaise)} lakh floor you set.`,
      );
      continue;
    }

    kept.push({ variant, price });
  }

  return { candidates: kept, exclusions };
}

/**
 * Fuel feasibility gates (FR-A4).
 *
 * Only two powertrains are gated, because only two can leave a buyer stranded:
 * CNG (and hydrogen) on a network that may not exist where they live, and EVs
 * where no home charging meets either a thin public DC network or a daily
 * distance the battery cannot cover.
 *
 * Hybrids and plug-in hybrids are never range-gated. They carry a liquid fuel
 * path, so a short battery is an efficiency question for stage 4, not a
 * feasibility one.
 */
export function applyFeasibilityGates(
  candidates: readonly PricedCandidate[],
  profile: RecommendationProfile,
  infra: InfraSnapshot,
): { candidates: PricedCandidate[]; exclusions: Exclusion[]; assumptions: string[] } {
  const kept: PricedCandidate[] = [];
  const exclusions: Exclusion[] = [];
  const assumptions = new Set<string>();

  /**
   * Without home charging, every kilometre between charges has to come out of
   * one public stop. A long daily total and a long single trip both force that
   * stop, so the binding figure is whichever is larger.
   */
  const kmBetweenCharges = Math.max(
    profile.usage.dailyKm,
    profile.usage.typicalTripKm,
  );

  for (const entry of candidates) {
    const { variant } = entry;
    const reject = (code: ExclusionCode, reason: string) => {
      exclusions.push(exclude(variant, "feasibility_gate", code, reason));
    };

    const networkType = NETWORK_DEPENDENT_FUELS[variant.fuelType];
    if (networkType !== undefined) {
      const reading = infra[networkType];
      if (reading === undefined) {
        assumptions.add(
          `No ${networkType.toUpperCase()} station data for this location; ${variant.fuelType} vehicles were not tested for refuelling access.`,
        );
      } else if (
        reading.stationCount === 0 ||
        (reading.percentile !== null &&
          reading.percentile <= GATE_THRESHOLDS.networkPercentileFloor)
      ) {
        reject(
          "refuelling_network_absent",
          reading.stationCount === 0
            ? `No ${networkType.toUpperCase()} stations recorded in your area.`
            : `${networkType.toUpperCase()} stations here are in the bottom ${GATE_THRESHOLDS.networkPercentileFloor}% nationally — refuelling would shape every trip.`,
        );
        continue;
      }
    }

    if (variant.fuelType === "electric" && !profile.charging.homeCharging) {
      if (variant.realWorldRangeKm === null) {
        assumptions.add(
          "Real-world range is not published for every electric variant; those were not tested against your daily distance.",
        );
      } else {
        const usableKm = Math.floor(
          variant.realWorldRangeKm * GATE_THRESHOLDS.evRangeUtilisation,
        );
        if (kmBetweenCharges > usableKm) {
          reject(
            "ev_range_short_no_home_charging",
            `Real-world range is ${variant.realWorldRangeKm} km, about ${usableKm} km once headroom is allowed for. You cover ${kmBetweenCharges} km between charges and have no home charging.`,
          );
          continue;
        }
      }

      const dc = infra.ev_dc;
      if (dc === undefined) {
        assumptions.add(
          "No public DC charging data for this location; electric vehicles were not tested for charging access.",
        );
      } else if (
        dc.stationCount === 0 ||
        (dc.percentile !== null &&
          dc.percentile <= GATE_THRESHOLDS.networkPercentileFloor) ||
        dc.confidenceScore < GATE_THRESHOLDS.evDcConfidenceFloor
      ) {
        reject(
          "ev_thin_dc_network_no_home_charging",
          "You have no home charging, and public fast charging here is either sparse or too thinly evidenced to rely on.",
        );
        continue;
      }
    }

    kept.push(entry);
  }

  return { candidates: kept, exclusions, assumptions: [...assumptions] };
}

/** Stage 1 end to end: filters, then gates over the survivors. */
export function runStage1(input: Stage1Input): Stage1Result {
  const filtered = applyHardFilters(input);
  const gated = applyFeasibilityGates(
    filtered.candidates,
    input.profile,
    input.infra,
  );

  return {
    candidates: gated.candidates,
    exclusions: [...filtered.exclusions, ...gated.exclusions],
    assumptions: gated.assumptions,
  };
}
