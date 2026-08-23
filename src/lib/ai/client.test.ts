import { APICallError, RetryError, simulateReadableStream } from "ai";
import { MockLanguageModelV4, type MockLanguageModelV4 as MockType } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  buildSdkOptions,
  generateNarrative,
  generateStructured,
  streamNarrative,
} from "./client";
import { HAIKU_MODEL_ID, LLM_POLICIES } from "./config";
import type { LlmCallRecord } from "./telemetry";

/**
 * These tests never hit the network and never read an API key: every call gets
 * an injected `MockLanguageModelV4`, which is exactly why the wrapper takes a
 * `model` override.
 */

function textResult(text = "Hello, world!") {
  return {
    content: [{ type: "text" as const, text }],
    finishReason: { unified: "stop" as const, raw: undefined },
    usage: {
      inputTokens: {
        total: 100,
        noCache: 60,
        cacheRead: 40,
        cacheWrite: undefined,
      },
      outputTokens: { total: 20, text: 20, reasoning: undefined },
    },
    warnings: [],
  };
}

function textStreamResult(deltas: string[]) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "text-start" as const, id: "t1" },
        ...deltas.map((delta) => ({
          type: "text-delta" as const,
          id: "t1",
          delta,
        })),
        { type: "text-end" as const, id: "t1" },
        {
          type: "finish" as const,
          finishReason: { unified: "stop" as const, raw: undefined },
          usage: {
            inputTokens: {
              total: 100,
              noCache: 60,
              cacheRead: 40,
              cacheWrite: undefined,
            },
            outputTokens: { total: 20, text: 20, reasoning: undefined },
          },
        },
      ],
      chunkDelayInMs: null,
      initialDelayInMs: null,
    }),
  };
}

function retryableError() {
  return new APICallError({
    message: "rate limited",
    url: "https://ai-gateway.vercel.sh/v4/ai",
    requestBodyValues: {},
    statusCode: 429,
    isRetryable: true,
  });
}

function collectingSink() {
  const records: LlmCallRecord[] = [];
  return { records, sink: (record: LlmCallRecord) => void records.push(record) };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("buildSdkOptions", () => {
  it("defaults to the single gateway model id and binds no tools", () => {
    const { shared } = buildSdkOptions({
      purpose: "recommendation_narrative",
      prompt: "narrate",
    });

    expect(shared.model).toBe(HAIKU_MODEL_ID);
    // Absence, not `{}`. An empty tools object is still a tools key, and some
    // providers treat its presence as enabling tool syntax.
    expect(Object.keys(shared)).not.toContain("tools");
    expect(Object.keys(shared)).not.toContain("toolChoice");
    expect(Object.keys(shared)).not.toContain("activeTools");
  });

  it("takes maxRetries and timeout from the purpose's policy, not the call site", () => {
    for (const purpose of ["profile_parse", "extraction"] as const) {
      const { shared } = buildSdkOptions({ purpose, prompt: "x" });
      expect(shared.maxRetries).toBe(LLM_POLICIES[purpose].maxRetries);
      expect(shared.timeout).toBe(LLM_POLICIES[purpose].timeoutMs);
      expect(shared.maxOutputTokens).toBe(LLM_POLICIES[purpose].maxOutputTokens);
      expect(shared.temperature).toBe(LLM_POLICIES[purpose].temperature);
    }
  });

  it("lets a call site raise maxOutputTokens but never the retry or timeout budget", () => {
    const { shared } = buildSdkOptions({
      purpose: "profile_parse",
      prompt: "x",
      maxOutputTokens: 4_242,
    });

    expect(shared.maxOutputTokens).toBe(4_242);
    expect(shared.maxRetries).toBe(LLM_POLICIES.profile_parse.maxRetries);
    expect(shared.timeout).toBe(LLM_POLICIES.profile_parse.timeoutMs);
  });

  it("records the injected model's own id when a model is overridden", () => {
    const { context } = buildSdkOptions({
      purpose: "e20_guidance",
      prompt: "x",
      model: new MockLanguageModelV4({ modelId: "mock-model" }),
    });

    expect(context.model).toBe("mock-model");
    expect(context.purpose).toBe("e20_guidance");
    expect(context.runId).toBeNull();
  });
});

describe("the no-tools guarantee", () => {
  it("is a compile error, not a convention", () => {
    // Every `@ts-expect-error` below FAILS `pnpm typecheck` if the option type
    // ever loosens enough to accept the key. That is the point of the block:
    // it is a type test that runs in CI as part of the build, not an assertion.
    const base = { purpose: "recommendation_narrative" as const, prompt: "x" };

    // @ts-expect-error a tool may never be bound through this module
    buildSdkOptions({ ...base, tools: {} });
    // @ts-expect-error tool choice implies tools
    buildSdkOptions({ ...base, toolChoice: "auto" });
    // @ts-expect-error a tool loop implies tools
    buildSdkOptions({ ...base, stopWhen: [] });
    // @ts-expect-error the retry budget belongs to the purpose's policy
    buildSdkOptions({ ...base, maxRetries: 99 });
    // @ts-expect-error the timeout budget belongs to the purpose's policy
    buildSdkOptions({ ...base, timeout: 1 });
    // @ts-expect-error the logging hook is wired by this module
    buildSdkOptions({ ...base, onLanguageModelCallEnd: () => {} });

    expect(true).toBe(true);
  });

  it("survives a caller that bypasses the types entirely", () => {
    // A JS call site, an `as any`, or an options object deserialised from JSON
    // gets past TypeScript. The keys are stripped at runtime as well.
    const smuggled = {
      purpose: "recommendation_narrative",
      prompt: "x",
      tools: { webSearch: { description: "search the web" } },
      toolChoice: "required",
      maxRetries: 99,
      timeout: 1,
    } as unknown as Parameters<typeof buildSdkOptions>[0];

    const { shared } = buildSdkOptions(smuggled);

    expect(shared).not.toHaveProperty("tools");
    expect(shared).not.toHaveProperty("toolChoice");
    expect(shared.maxRetries).toBe(
      LLM_POLICIES.recommendation_narrative.maxRetries,
    );
    expect(shared.timeout).toBe(
      LLM_POLICIES.recommendation_narrative.timeoutMs,
    );
  });
});

describe("generateNarrative", () => {
  it("binds no tools at the provider boundary", async () => {
    // The load-bearing test. Everything above is intent; this is what the model
    // actually received. Carbon Miles does no live retrieval at conversation
    // time, and a tool reaching this object would silently end that.
    const model: MockType = new MockLanguageModelV4({
      doGenerate: async () => textResult(),
    });

    await generateNarrative({
      purpose: "recommendation_narrative",
      model,
      prompt: "Narrate this scored result set.",
    });

    expect(model.doGenerateCalls).toHaveLength(1);
    const call = model.doGenerateCalls[0];
    expect(call.tools ?? []).toHaveLength(0);
    // Note: ai@7 always sends `toolChoice: { type: 'auto' }`, tools or not — it
    // is inert with an empty tool list, so the empty list above is the real
    // guarantee. Asserting on toolChoice would test the SDK's default, not us.
  });

  it("forwards the policy's sampling settings to the provider", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => textResult(),
    });

    await generateNarrative({
      purpose: "profile_parse",
      model,
      prompt: "Parse this.",
    });

    expect(model.doGenerateCalls[0].maxOutputTokens).toBe(
      LLM_POLICIES.profile_parse.maxOutputTokens,
    );
    expect(model.doGenerateCalls[0].temperature).toBe(
      LLM_POLICIES.profile_parse.temperature,
    );
  });

  it("emits exactly one llm_calls record with the real token counts", async () => {
    const { records, sink } = collectingSink();

    const result = await generateNarrative({
      purpose: "recommendation_narrative",
      runId: "11111111-1111-4111-8111-111111111111",
      sink,
      model: new MockLanguageModelV4({
        modelId: "mock-haiku",
        doGenerate: async () => textResult("Narrated."),
      }),
      prompt: "Narrate.",
    });

    expect(result.text).toBe("Narrated.");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      purpose: "recommendation_narrative",
      model: "mock-haiku",
      runId: "11111111-1111-4111-8111-111111111111",
      inputTokens: 100,
      cachedInputTokens: 40,
      outputTokens: 20,
      costMicroUsd: 0,
      cacheHit: false,
      guardRejected: false,
      error: null,
      generationId: null,
    });
    expect(records[0].latencyMs).toBeTypeOf("number");
  });

  it("does not let a throwing sink break the call", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await generateNarrative({
      purpose: "recommendation_narrative",
      sink: () => {
        throw new Error("telemetry is down");
      },
      model: new MockLanguageModelV4({ doGenerate: async () => textResult() }),
      prompt: "Narrate.",
    });

    expect(result.text).toBe("Hello, world!");
    expect(console.error).toHaveBeenCalled();
  });

  it("meters a failed call and rethrows", async () => {
    const { records, sink } = collectingSink();

    await expect(
      generateNarrative({
        purpose: "profile_parse",
        sink,
        model: new MockLanguageModelV4({
          doGenerate: async () => {
            throw new Error("provider exploded");
          },
        }),
        prompt: "Parse.",
      }),
    ).rejects.toThrow();

    expect(records).toHaveLength(1);
    expect(records[0].error).toContain("provider exploded");
    expect(records[0].inputTokens).toBe(0);
    expect(records[0].latencyMs).toBeNull();
  });
});

describe("retry wiring", () => {
  it("retries a retryable provider error up to the policy's maxRetries", async () => {
    // The SDK's backoff floor is a hardcoded 2000ms and is unreachable from the
    // options, so this must run on fake timers or it costs 2 real seconds.
    vi.useFakeTimers();

    let attempts = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        attempts += 1;
        if (attempts === 1) throw retryableError();
        return textResult("recovered");
      },
    });

    const pending = generateNarrative({
      purpose: "profile_parse", // maxRetries: 1
      model,
      prompt: "Parse.",
    });

    await vi.advanceTimersByTimeAsync(2_500);
    const result = await pending;

    expect(LLM_POLICIES.profile_parse.maxRetries).toBe(1);
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(result.text).toBe("recovered");
  });

  it("gives up after maxRetries with a RetryError, and meters it once", async () => {
    vi.useFakeTimers();
    const { records, sink } = collectingSink();

    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw retryableError();
      },
    });

    const pending = generateNarrative({
      purpose: "profile_parse", // maxRetries: 1 => 2 attempts total
      sink,
      model,
      prompt: "Parse.",
    }).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(2_500);
    const error = await pending;

    expect(RetryError.isInstance(error)).toBe(true);
    expect((error as RetryError).reason).toBe("maxRetriesExceeded");
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(records).toHaveLength(1);
    expect(records[0].error).toContain("rate limited");
  });

  it("does not retry a non-retryable error", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new APICallError({
          message: "bad request",
          url: "https://ai-gateway.vercel.sh/v4/ai",
          requestBodyValues: {},
          statusCode: 400,
          isRetryable: false,
        });
      },
    });

    await expect(
      generateNarrative({
        purpose: "extraction", // maxRetries: 3 — irrelevant, the error is fatal
        model,
        prompt: "Extract.",
      }),
    ).rejects.toThrow();

    expect(model.doGenerateCalls).toHaveLength(1);
  });
});

describe("timeout wiring", () => {
  it("hands the policy's timeout to the SDK, which turns it into an abort signal", async () => {
    // `mergeAbortSignals` in ai@7 calls `AbortSignal.timeout(totalTimeoutMs)`.
    // Spying on it both proves the right budget was forwarded and lets the
    // deadline fire immediately instead of after 8 real seconds.
    const controller = new AbortController();
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(controller.signal);

    const { records, sink } = collectingSink();

    const pending = generateNarrative({
      purpose: "profile_parse",
      sink,
      model: new MockLanguageModelV4({
        // Settles only when aborted — the way a real fetch-backed provider
        // behaves. A mock that ignores the signal would hang forever and prove
        // nothing about whether the deadline reached the provider.
        doGenerate: ({ abortSignal }) =>
          new Promise((_resolve, reject) => {
            // `addEventListener("abort")` never fires on an already-aborted
            // signal, and the SDK reaches the provider a few microtasks after
            // the call is made — so check `aborted` first.
            if (abortSignal?.aborted) {
              reject(abortSignal.reason);
              return;
            }
            abortSignal?.addEventListener("abort", () =>
              reject(abortSignal.reason),
            );
          }),
      }),
      prompt: "Parse.",
    });

    expect(timeoutSpy).toHaveBeenCalledWith(LLM_POLICIES.profile_parse.timeoutMs);

    controller.abort(new Error("timed out"));
    await expect(pending).rejects.toThrow();

    expect(records).toHaveLength(1);
    expect(records[0].error).not.toBeNull();
  });

  it("still forwards a caller-supplied abortSignal alongside the policy timeout", async () => {
    const caller = new AbortController();
    const model = new MockLanguageModelV4({
      doGenerate: async () => textResult(),
    });

    await generateNarrative({
      purpose: "profile_parse",
      model,
      abortSignal: caller.signal,
      prompt: "Parse.",
    });

    // The provider receives a merged signal, not the caller's raw one.
    expect(model.doGenerateCalls[0].abortSignal).toBeInstanceOf(AbortSignal);
  });
});

describe("streamNarrative", () => {
  it("returns synchronously and streams text", async () => {
    const result = streamNarrative({
      purpose: "recommendation_narrative",
      model: new MockLanguageModelV4({
        doStream: async () => textStreamResult(["Hello", ", ", "world!"]),
      }),
      prompt: "Narrate.",
    });

    // Not a promise: awaiting `streamText` would be a no-op that hides the point.
    expect(typeof (result as { then?: unknown }).then).toBe("undefined");

    let text = "";
    for await (const chunk of result.textStream) text += chunk;
    expect(text).toBe("Hello, world!");
  });

  it("binds no tools on the streaming path either", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => textStreamResult(["ok"]),
    });

    const result = streamNarrative({
      purpose: "recommendation_narrative",
      model,
      prompt: "Narrate.",
    });
    for await (const chunk of result.textStream) void chunk;

    expect(model.doStreamCalls).toHaveLength(1);
    expect(model.doStreamCalls[0].tools ?? []).toHaveLength(0);
  });

  it("emits exactly one record for a streamed call", async () => {
    const { records, sink } = collectingSink();

    const result = streamNarrative({
      purpose: "recommendation_narrative",
      sink,
      model: new MockLanguageModelV4({
        modelId: "mock-haiku",
        doStream: async () => textStreamResult(["a", "b"]),
      }),
      prompt: "Narrate.",
    });
    for await (const chunk of result.textStream) void chunk;
    await result.finalStep;

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      purpose: "recommendation_narrative",
      model: "mock-haiku",
      inputTokens: 100,
      cachedInputTokens: 40,
      outputTokens: 20,
      error: null,
    });
  });

  it("meters a stream that fails before producing a record", async () => {
    // This is the case the brief warns about: `onLanguageModelCallEnd` never
    // fires, and `result.usage` would never settle, so a naive implementation
    // loses exactly the calls most worth metering. ai@7 routes the failure to
    // `onError` and ends the text stream rather than throwing out of it.
    const { records, sink } = collectingSink();

    const result = streamNarrative({
      purpose: "recommendation_narrative",
      sink,
      model: new MockLanguageModelV4({
        doStream: async () => {
          throw new Error("stream never opened");
        },
      }),
      prompt: "Narrate.",
    });

    let text = "";
    for await (const chunk of result.textStream) text += chunk;

    expect(text).toBe("");
    expect(records).toHaveLength(1);
    expect(records[0].error).toContain("stream never opened");
  });
});

describe("generateStructured", () => {
  it("produces a parsed object without generateObject, and still binds no tools", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        ...textResult(JSON.stringify({ city: "Pune", monthlyKm: 900 })),
      }),
    });

    const result = await generateStructured({
      purpose: "profile_parse",
      model,
      prompt: "I drive about 900 km a month around Pune.",
      schema: z.object({ city: z.string(), monthlyKm: z.number() }),
    });

    expect(result.output).toEqual({ city: "Pune", monthlyKm: 900 });
    // `Output.object` uses response-format JSON, not a tool call.
    expect(model.doGenerateCalls[0].tools ?? []).toHaveLength(0);
    expect(model.doGenerateCalls[0].responseFormat?.type).toBe("json");
  });

  it("inherits the purpose's retry and timeout policy", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");

    await generateStructured({
      purpose: "extraction",
      model: new MockLanguageModelV4({
        doGenerate: async () => textResult(JSON.stringify({ ok: true })),
      }),
      prompt: "Extract.",
      schema: z.object({ ok: z.boolean() }),
    });

    expect(timeoutSpy).toHaveBeenCalledWith(LLM_POLICIES.extraction.timeoutMs);
  });
});
