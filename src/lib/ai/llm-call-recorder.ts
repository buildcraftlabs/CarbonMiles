/**
 * The only file in `src/lib/ai/` that touches the database.
 *
 * It is separate from `./client.ts` on purpose: `src/db/client.ts` throws at
 * module load when `DATABASE_URL` is unset, so a single import of it from the
 * wrapper would make `pnpm test` require a live database. Nothing in this
 * directory imports this file — callers wire it in explicitly, and
 * `./index.ts` deliberately does not re-export it.
 *
 * In a Route Handler, call this inside `after()` from `next/server` so the
 * insert does not sit between the model response and the user.
 */

import { db } from "@/db/client";
import { llmCalls } from "@/db/schema/users";

import type { LlmCallRecord, LlmCallSink } from "./telemetry";

/**
 * Note what is *not* written: `generationId` has no column. It is the handle for
 * resolving real cost out of band via the gateway's `getGenerationInfo`, which
 * is a separate concern — `costMicroUsd` ships as 0 rather than as a number
 * computed from hardcoded per-token prices we would have invented.
 */
export const dbLlmCallSink: LlmCallSink = async (record: LlmCallRecord) => {
  try {
    await db.insert(llmCalls).values({
      purpose: record.purpose,
      model: record.model,
      runId: record.runId,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      cachedInputTokens: record.cachedInputTokens,
      costMicroUsd: record.costMicroUsd,
      latencyMs: record.latencyMs,
      cacheHit: record.cacheHit,
      guardRejected: record.guardRejected,
      error: record.error,
    });
  } catch (cause) {
    // Metering must never fail a user request. Losing a row is strictly better
    // than turning a good recommendation into a 500.
    console.error("[ai] failed to insert llm_calls row", cause);
  }
};
