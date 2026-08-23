import type {
  BodyType,
  FuelType,
  LifecycleStatus,
  StationType,
  VehicleCategory,
} from "./enums";
import type { OnRoadPrice } from "./on-road";

/**
 * The shapes stage 1 consumes and produces.
 *
 * These are plain data, not Drizzle rows: `src/lib/engine/` never imports
 * `src/db/`, so the query layer projects into these types and the engine runs
 * unchanged against fixtures.
 */

/**
 * A buyable configuration, as the engine sees it.
 *
 * Deliberately absent: `claimedEfficiency` and `claimedRangeKm`. ARAI figures
 * overstate real economy by a wide margin, and the cheapest way to guarantee
 * they never reach a calculation (FR-A7) is to leave them out of the type the
 * calculation is written against.
 */
export interface CandidateVariant {
  variantId: string;
  /** Needed downstream: stage 5 caps variants per model when diversifying. */
  modelId: string;
  name: string;
  category: VehicleCategory;
  bodyType: BodyType;
  status: LifecycleStatus;
  fuelType: FuelType;
  exShowroomPaise: number | null;
  seatingCapacity: number | null;
  payloadKg: number | null;
  /** What it actually does in Indian traffic with the AC on. Drives the EV
   * feasibility gate; `null` means the gate cannot be tested, not that it
   * passes silently. */
  realWorldRangeKm: number | null;
  /**
   * `false` only when `variant_availability` carries an explicit exclusion for
   * the user's state. Absence of a row means available — the table records
   * known exclusions, not positive availability.
   */
  availableInState: boolean;
  /** Why the state excludes it, where the source says so. */
  availabilityNote?: string | null;
}

/**
 * One `infra_density` rollup for the user's city, by station type.
 *
 * The engine reads the rollup, never `fuel_stations`: station-level data in
 * India is incomplete and goes stale fast, and a five-year purchase decision
 * turns on a density band rather than on a count.
 */
export interface InfraDensityReading {
  type: StationType;
  stationCount: number;
  /** 0–100 against every city we hold data for. `null` when uncomputed. */
  percentile: number | null;
  /** 0–100. A thin source produces a low score, so that sparse evidence
   * weakens the sub-score in stage 4 rather than triggering a false gate. */
  confidenceScore: number;
}

/** What we know about the user's city. A missing key means no data at all. */
export type InfraSnapshot = Partial<Record<StationType, InfraDensityReading>>;

export type ExclusionStage = "hard_filter" | "feasibility_gate";

export type ExclusionCode =
  // hard filters
  | "not_active"
  | "wrong_category"
  | "body_type_wrong_category"
  | "fuel_excluded_by_user"
  | "unavailable_in_state"
  | "seating_below_requirement"
  | "seating_unknown"
  | "payload_below_requirement"
  | "payload_unknown"
  | "price_unknown"
  | "on_road_price_unknown"
  | "above_budget"
  | "below_budget_floor"
  // feasibility gates
  | "refuelling_network_absent"
  | "ev_thin_dc_network_no_home_charging"
  | "ev_range_short_no_home_charging";

/**
 * A variant that did not survive, and why.
 *
 * FR-A4 requires exclusions be reported rather than silently applied, so the
 * reason is a finished sentence the UI can render as-is. It is also the
 * deterministic fallback when the narrative model is unavailable, which is why
 * it is written here rather than assembled in the view.
 */
export interface Exclusion {
  variantId: string;
  name: string;
  stage: ExclusionStage;
  code: ExclusionCode;
  reason: string;
}

/** A variant that survived stage 1, with the price it was judged against. */
export interface PricedCandidate {
  variant: CandidateVariant;
  price: OnRoadPrice;
}
