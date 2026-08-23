/**
 * The seam between the AI SDK and the `llm_calls` table.
 *
 * Nothing here imports from `src/db/`. `src/db/client.ts` throws at module load
 * when `DATABASE_URL` is absent, so anything that reaches it cannot be unit
 * tested without a live database. The record type below is a plain object and
 * the sink is a function the caller supplies — the Drizzle insert lives alone
 * in `./llm-call-recorder.ts`, which nothing in this module graph imports.
 */

import type { LanguageModelCallEndEvent, LanguageModelUsage } from "ai";

import type { LlmPurpose } from "./config";

/**
 * One row destined for `llm_calls` (see `src/db/schema/users.ts`), plus
 * `generationId`, which is not a column.
 *
 * Field-by-field mapping and its assumptions:
 * - `inputTokens`     ← `usage.inputTokens`, the **total** prompt tokens.
 * - `cachedInputTokens` ← `usage.inputTokenDetails.cacheReadTokens`, which the
 *   AI SDK documents as a *subset* of `inputTokens`, not a disjoint bucket. The
 *   schema does not say which it wants; `telemetry.test.ts` pins the subset
 *   reading so a later change has to break a test rather than silently corrupt
 *   every cost-per-run figure.
 * - `latencyMs`       ← `event.performance.responseTimeMs`, rounded.
 * - `costMicroUsd`    ← 0 by default. The AI SDK returns no cost. The only real
 *   source is the gateway's out-of-band `getGenerationInfo({ id })`, so we carry
 *   `generationId` and leave cost to a follow-up. Hardcoding per-token prices
 *   here would be inventing data that silently rots.
 * - `cacheHit` / `guardRejected` ← caller-supplied. These are Carbon Miles
 *   concepts (the narrative cache and the number-validation guard), not
 *   AI-SDK signals, so this module cannot know them.
 */
export interface LlmCallRecord {
  readonly purpose: LlmPurpose;
  readonly model: string;
  readonly runId: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly costMicroUsd: number;
  readonly latencyMs: number | null;
  readonly cacheHit: boolean;
  readonly guardRejected: boolean;
  readonly error: string | null;
  /**
   * `providerMetadata.gateway.generationId`. Not an `llm_calls` column — it is
   * the handle that lets a later job resolve the real cost via
   * `gateway.getGenerationInfo({ id })`.
   */
  readonly generationId: string | null;
}

/**
 * Where a finished call goes. Deliberately a function: it keeps this module and
 * `./client.ts` free of any database dependency, and it lets a route handler
 * defer the write into Next.js 16's `after()` without this layer knowing.
 */
export type LlmCallSink = (record: LlmCallRecord) => void | Promise<void>;

/** The default. A wrapper with no sink must still be fully usable. */
export const noopLlmCallSink: LlmCallSink = () => {};

/** Context the AI SDK cannot supply, provided by the caller. */
export interface LlmCallContext {
  readonly purpose: LlmPurpose;
  /** The model id we asked the gateway for. */
  readonly model: string;
  readonly runId?: string | null;
  readonly cacheHit?: boolean;
  readonly guardRejected?: boolean;
}

export interface TokenCounts {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
}

/**
 * `LanguageModelUsage` fields are all `number | undefined`; the `llm_calls`
 * columns are `NOT NULL DEFAULT 0`. Unknown means 0 here — an absent count is
 * not evidence of a non-zero one.
 */
export function usageToTokenCounts(
  usage: LanguageModelUsage | undefined,
): TokenCounts {
  return {
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    cachedInputTokens: usage?.inputTokenDetails?.cacheReadTokens ?? 0,
  };
}

/**
 * Micro-USD, matching `llm_calls.costMicroUsd`.
 *
 * This is *not* the paise rule — LLM spend is billed in USD by the gateway and
 * the column is explicitly documented as micro-USD. Same principle (integers,
 * no float drift), different unit. Do not "fix" this into paise.
 */
export function usdToMicroUsd(usd: number): number {
  if (!Number.isFinite(usd)) return 0;
  return Math.round(usd * 1_000_000);
}

/**
 * Pull the gateway generation id out of provider metadata.
 *
 * `ProviderMetadata` values are `JSONValue`, so this narrows rather than casts:
 * a non-string (or missing `gateway` namespace, as with any non-gateway model)
 * yields `null` instead of a lie.
 */
export function extractGenerationId(
  providerMetadata: LanguageModelCallEndEvent["providerMetadata"],
): string | null {
  const gateway: unknown = providerMetadata?.gateway;
  if (typeof gateway !== "object" || gateway === null) return null;
  const id: unknown = (gateway as Record<string, unknown>).generationId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/** `llm_calls.error` is unbounded `text`; a runaway provider message is not worth storing whole. */
const MAX_ERROR_CHARS = 2_000;

export function describeError(error: unknown): string {
  const message =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : typeof error === "string"
        ? error
        : JSON.stringify(error) ?? String(error);
  return message.slice(0, MAX_ERROR_CHARS);
}

/**
 * Build a record from `onLanguageModelCallEnd`, which fires once per provider
 * call for both `generateText` and `streamText`.
 *
 * `model` prefers what the provider says it actually served, falling back to
 * what we asked for. The gateway can serve an alias, and the row should record
 * the truth rather than the request.
 */
export function recordFromCallEndEvent(
  event: LanguageModelCallEndEvent,
  context: LlmCallContext,
): LlmCallRecord {
  const tokens = usageToTokenCounts(event.usage);
  const responseTimeMs = event.performance?.responseTimeMs;

  return {
    purpose: context.purpose,
    model: event.modelId || context.model,
    runId: context.runId ?? null,
    ...tokens,
    costMicroUsd: 0,
    latencyMs:
      typeof responseTimeMs === "number" && Number.isFinite(responseTimeMs)
        ? Math.round(responseTimeMs)
        : null,
    cacheHit: context.cacheHit ?? false,
    guardRejected: context.guardRejected ?? false,
    error: null,
    generationId: extractGenerationId(event.providerMetadata),
  };
}

/**
 * A failed call is the one you most want metered, so failures get a row too:
 * zeroed tokens, `error` set. `latencyMs` is null because no provider response
 * was timed.
 */
export function errorRecord(
  error: unknown,
  context: LlmCallContext,
): LlmCallRecord {
  return {
    purpose: context.purpose,
    model: context.model,
    runId: context.runId ?? null,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    costMicroUsd: 0,
    latencyMs: null,
    cacheHit: context.cacheHit ?? false,
    guardRejected: context.guardRejected ?? false,
    error: describeError(error),
    generationId: null,
  };
}
