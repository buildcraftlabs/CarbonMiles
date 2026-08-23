/**
 * Drives the REAL engine, stage 1 through stage 5, over the sample fixtures.
 *
 * This is the whole demo: no database, no LLM, no network. `src/lib/engine/` is
 * pure functions by design, so feeding it in-memory data exercises exactly the
 * code path production will use — the only thing swapped out is where the rows
 * came from. The stage ordering itself lives in `engine/pipeline.ts`, so the
 * demo cannot drift away from what the API will run.
 */

import {
  runRecommendation,
  type EconomicsFailure,
} from "@/lib/engine/pipeline";
import { parseProfile } from "@/lib/engine/profile";
import type { ExplainabilityPayload } from "@/lib/engine/stage5";

import {
  AS_OF,
  ENGINE_VERSION,
  emissionFactors,
  FLEET,
  infra,
  onRoadFactors,
  profileInput,
  tables,
} from "./fixtures";

export type { EconomicsFailure };

export interface DemoRun {
  payload: ExplainabilityPayload;
  /** Vehicles that survived stage 1 but could not be costed, and why. */
  economicsFailures: EconomicsFailure[];
}

export function runDemo(): DemoRun {
  const result = runRecommendation({
    profile: parseProfile(profileInput),
    fleet: FLEET,
    onRoadFactors,
    infra,
    tables,
    emissionFactors,
    asOf: AS_OF,
    engineVersion: ENGINE_VERSION,
    // `limit: 6` rather than the default 5 so the strong hybrid — the vehicle
    // carrying the deliberate data gap — reaches the page instead of being
    // omitted just off the end of the list. Showing how the engine handles
    // missing data is the point of including it.
    limit: 6,
    // `provenance` is deliberately NOT passed. Every figure in the fixtures is
    // invented; attributing invented numbers to invented sources would be the
    // precise lie the provenance rule exists to prevent. Omitted, the engine
    // reports the gap itself, which is the more honest demo beat.
  });

  if (!result.ok) {
    throw new Error(
      `Demo stage ${result.stage} failed: [${result.code}] ${result.reason}`,
    );
  }

  return {
    payload: result.payload,
    economicsFailures: result.economicsFailures,
  };
}
