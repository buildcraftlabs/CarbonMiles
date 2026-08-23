import type { LanguageModelCallEndEvent, LanguageModelUsage } from "ai";
import { describe, expect, it } from "vitest";

import {
  describeError,
  errorRecord,
  extractGenerationId,
  noopLlmCallSink,
  recordFromCallEndEvent,
  usageToTokenCounts,
  usdToMicroUsd,
  type LlmCallContext,
} from "./telemetry";

const context: LlmCallContext = {
  purpose: "recommendation_narrative",
  model: "anthropic/claude-haiku-4.5",
  runId: "11111111-1111-4111-8111-111111111111",
};

function usage(overrides: Partial<LanguageModelUsage> = {}): LanguageModelUsage {
  return {
    inputTokens: undefined,
    inputTokenDetails: {
      noCacheTokens: undefined,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
    },
    outputTokens: undefined,
    outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
    totalTokens: undefined,
    ...overrides,
  };
}

function callEndEvent(
  overrides: Partial<LanguageModelCallEndEvent> = {},
): LanguageModelCallEndEvent {
  return {
    provider: "gateway",
    modelId: "anthropic/claude-haiku-4.5",
    callId: "call-1",
    finishReason: "stop",
    usage: usage({ inputTokens: 100, outputTokens: 40 }),
    content: [{ type: "text", text: "hello" }],
    responseId: "resp-1",
    performance: {
      responseTimeMs: 812.6,
      effectiveOutputTokensPerSecond: 0,
      outputTokensPerSecond: undefined,
      inputTokensPerSecond: undefined,
      effectiveTotalTokensPerSecond: 0,
      timeToFirstOutputMs: undefined,
    },
    ...overrides,
  } as LanguageModelCallEndEvent;
}

describe("usageToTokenCounts", () => {
  it("reads cachedInputTokens from inputTokenDetails.cacheReadTokens", () => {
    // v7 has no flat `usage.cachedInputTokens`. Reading the wrong place would
    // silently record 0 for every cached call and never error.
    const counts = usageToTokenCounts(
      usage({
        inputTokens: 1_000,
        inputTokenDetails: {
          noCacheTokens: 250,
          cacheReadTokens: 750,
          cacheWriteTokens: 0,
        },
        outputTokens: 120,
      }),
    );

    expect(counts).toEqual({
      inputTokens: 1_000,
      outputTokens: 120,
      cachedInputTokens: 750,
    });
  });

  it("treats cachedInputTokens as a SUBSET of inputTokens, not a disjoint bucket", () => {
    // Pinned deliberately: llm_calls has both columns and documents neither
    // relationship. If this ever flips, cost-per-run figures change silently.
    const counts = usageToTokenCounts(
      usage({
        inputTokens: 1_000,
        inputTokenDetails: {
          noCacheTokens: 250,
          cacheReadTokens: 750,
          cacheWriteTokens: 0,
        },
      }),
    );

    expect(counts.inputTokens).toBe(1_000);
    expect(counts.cachedInputTokens).toBeLessThanOrEqual(counts.inputTokens);
  });

  it("maps every unknown count to 0, matching the NOT NULL DEFAULT 0 columns", () => {
    expect(usageToTokenCounts(usage())).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
    });
  });

  it("tolerates a missing usage object", () => {
    expect(usageToTokenCounts(undefined)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
    });
  });
});

describe("usdToMicroUsd", () => {
  it("converts to integer micro-USD without float leakage", () => {
    expect(usdToMicroUsd(0.0000123)).toBe(12);
    expect(usdToMicroUsd(1)).toBe(1_000_000);
    expect(usdToMicroUsd(0.00000049)).toBe(0);
    expect(Number.isInteger(usdToMicroUsd(0.1 + 0.2))).toBe(true);
  });

  it("returns 0 for non-finite input rather than NaN into a bigint column", () => {
    expect(usdToMicroUsd(Number.NaN)).toBe(0);
    expect(usdToMicroUsd(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("extractGenerationId", () => {
  it("reads providerMetadata.gateway.generationId", () => {
    expect(
      extractGenerationId({ gateway: { generationId: "gen_01abc" } }),
    ).toBe("gen_01abc");
  });

  it("returns null when the gateway namespace is absent", () => {
    expect(extractGenerationId(undefined)).toBeNull();
    expect(extractGenerationId({})).toBeNull();
    expect(extractGenerationId({ anthropic: { cacheCreation: 1 } })).toBeNull();
  });

  it("returns null rather than lying when the value is not a non-empty string", () => {
    expect(extractGenerationId({ gateway: {} })).toBeNull();
    expect(extractGenerationId({ gateway: { generationId: "" } })).toBeNull();
    expect(extractGenerationId({ gateway: { generationId: 42 } })).toBeNull();
  });
});

describe("recordFromCallEndEvent", () => {
  it("builds a complete llm_calls row", () => {
    const record = recordFromCallEndEvent(
      callEndEvent({
        usage: usage({
          inputTokens: 900,
          inputTokenDetails: {
            noCacheTokens: 400,
            cacheReadTokens: 500,
            cacheWriteTokens: 0,
          },
          outputTokens: 70,
        }),
        providerMetadata: { gateway: { generationId: "gen_01xyz" } },
      }),
      context,
    );

    expect(record).toEqual({
      purpose: "recommendation_narrative",
      model: "anthropic/claude-haiku-4.5",
      runId: "11111111-1111-4111-8111-111111111111",
      inputTokens: 900,
      outputTokens: 70,
      cachedInputTokens: 500,
      costMicroUsd: 0,
      latencyMs: 813,
      cacheHit: false,
      guardRejected: false,
      error: null,
      generationId: "gen_01xyz",
    });
  });

  it("rounds responseTimeMs, because latency_ms is an integer column", () => {
    expect(
      recordFromCallEndEvent(
        callEndEvent({
          performance: {
            ...callEndEvent().performance,
            responseTimeMs: 1_500.4,
          },
        }),
        context,
      ).latencyMs,
    ).toBe(1_500);
  });

  it("leaves cost at 0 — the SDK returns none and inventing one would be fabricating data", () => {
    const record = recordFromCallEndEvent(callEndEvent(), context);
    expect(record.costMicroUsd).toBe(0);
  });

  it("carries caller-supplied cacheHit / guardRejected and defaults them false", () => {
    expect(
      recordFromCallEndEvent(callEndEvent(), {
        ...context,
        cacheHit: true,
        guardRejected: true,
      }),
    ).toMatchObject({ cacheHit: true, guardRejected: true });

    expect(recordFromCallEndEvent(callEndEvent(), context)).toMatchObject({
      cacheHit: false,
      guardRejected: false,
    });
  });

  it("records the model the provider actually served, falling back to the requested id", () => {
    expect(
      recordFromCallEndEvent(callEndEvent({ modelId: "anthropic/other" }), context)
        .model,
    ).toBe("anthropic/other");

    expect(
      recordFromCallEndEvent(callEndEvent({ modelId: "" }), context).model,
    ).toBe("anthropic/claude-haiku-4.5");
  });

  it("nulls runId when the call does not belong to a recommendation run", () => {
    const withoutRunId: LlmCallContext = {
      purpose: context.purpose,
      model: context.model,
    };
    expect(recordFromCallEndEvent(callEndEvent(), withoutRunId).runId).toBeNull();
    expect(
      recordFromCallEndEvent(callEndEvent(), { ...context, runId: null }).runId,
    ).toBeNull();
  });
});

describe("errorRecord", () => {
  it("meters a failed call with zeroed tokens and the message", () => {
    const record = errorRecord(new TypeError("boom"), context);
    expect(record).toEqual({
      purpose: "recommendation_narrative",
      model: "anthropic/claude-haiku-4.5",
      runId: "11111111-1111-4111-8111-111111111111",
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      costMicroUsd: 0,
      latencyMs: null,
      cacheHit: false,
      guardRejected: false,
      error: "TypeError: boom",
      generationId: null,
    });
  });
});

describe("describeError", () => {
  it("handles non-Error throwables", () => {
    expect(describeError("plain string")).toBe("plain string");
    expect(describeError({ code: 429 })).toBe('{"code":429}');
    expect(describeError(undefined)).toBe("undefined");
  });

  it("truncates a runaway message", () => {
    expect(describeError(new Error("x".repeat(10_000))).length).toBe(2_000);
  });
});

describe("noopLlmCallSink", () => {
  it("is safe to call and returns nothing", () => {
    expect(
      noopLlmCallSink(errorRecord(new Error("x"), context)),
    ).toBeUndefined();
  });
});
