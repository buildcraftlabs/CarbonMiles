/**
 * The one way Carbon Miles talks to a language model.
 *
 * Everything downstream (narrative generation, profile parsing, E20 guidance)
 * goes through here so that the model id, the retry budget, the timeout budget
 * and the `llm_calls` logging hook are decided in exactly one place.
 *
 * ## No tools. Ever.
 *
 * The product does no live web search at conversation time: every vehicle fact
 * comes from Postgres and the model only turns already-computed numbers into
 * prose. Binding a web-search, retrieval or any other tool here would quietly
 * destroy that guarantee, so it is blocked three ways: every tool-related AI SDK
 * key is typed `?: never`, those keys are also deleted at runtime before the
 * options reach the SDK (for callers who got past TypeScript), and
 * `client.test.ts` asserts on what the model object actually received.
 *
 * ## No provider package
 *
 * The model is a bare `"creator/model-name"` string, which is what makes the AI
 * SDK route through the Vercel AI Gateway. There is no `@ai-sdk/anthropic` in
 * `package.json` and `createGateway()` is never called, so no credential is read
 * at import time and this module type-checks and unit-tests without an API key.
 */

import {
  generateText,
  Output,
  streamText,
  type FlexibleSchema,
  type JSONValue,
  type LanguageModel,
  type LanguageModelCallOptions,
  type Prompt,
} from "ai";

import { HAIKU_MODEL_ID, policyFor, type LlmPurpose } from "./config";
import {
  errorRecord,
  noopLlmCallSink,
  recordFromCallEndEvent,
  type LlmCallContext,
  type LlmCallRecord,
  type LlmCallSink,
} from "./telemetry";

/**
 * `ai@7` declares `ProviderOptions` but does not re-export it, and
 * `@ai-sdk/provider-utils` is not hoisted by pnpm, so it cannot be imported.
 * This mirrors its definition (`Record<string, JSONObject>`) using `JSONValue`,
 * which `ai` *does* export.
 */
type ProviderOptions = Record<string, Record<string, JSONValue>>;

/**
 * Structural proof that this module cannot bind a tool.
 *
 * Each key is a real `generateText`/`streamText` option that would either
 * introduce a tool or drive a tool loop. Typing them `never` makes any value a
 * compile error while keeping the error message pointed at the right key.
 * Removing an entry here is a product decision, not a refactor.
 */
const TOOL_KEYS = [
  "tools",
  "toolChoice",
  "activeTools",
  "toolOrder",
  "toolApproval",
  "toolsContext",
  "runtimeContext",
  "stopWhen",
  "prepareStep",
  "repairToolCall",
  "experimental_repairToolCall",
  "experimental_toolCallers",
  "experimental_refineToolInput",
  "experimental_sandbox",
] as const;

type NoTools = { [K in (typeof TOOL_KEYS)[number]]?: never };

/**
 * Options this module owns and a caller must not set directly. They come from
 * `LLM_POLICIES` so that the latency and retry budget is a property of the
 * *purpose*, not of whichever call site was written most recently.
 */
const POLICY_KEYS = [
  "model",
  "maxRetries",
  "timeout",
  "onLanguageModelCallEnd",
  "experimental_onLanguageModelCallEnd",
  "onError",
  "onAbort",
] as const;

type OwnedByPolicy = {
  [K in Exclude<(typeof POLICY_KEYS)[number], "model">]?: never;
};

/**
 * The types above stop TypeScript callers. This stops everyone else: an untyped
 * call site, a `as any`, a JSON body deserialised into options. Both key sets
 * are physically removed before anything reaches the SDK.
 */
function stripReservedKeys<T extends object>(settings: T): T {
  const cleaned = { ...settings } as Record<string, unknown>;
  for (const key of [...TOOL_KEYS, ...POLICY_KEYS]) delete cleaned[key];
  return cleaned as T;
}

export interface LlmRequestContext {
  /** Selects the retry/timeout/token policy and lands in `llm_calls.purpose`. */
  purpose: LlmPurpose;
  /** `recommendation_runs.id`, when the call belongs to one. Must be a uuid. */
  runId?: string | null;
  /** Where the `llm_calls` row goes. Defaults to a no-op so no DB is required. */
  sink?: LlmCallSink;
  /** Narrative-cache hit. Carbon Miles concept; the SDK cannot know it. */
  cacheHit?: boolean;
  /** Number-validation guard rejected the output. Set by the guard, not here. */
  guardRejected?: boolean;
  /**
   * Model override. Exists so tests can inject `MockLanguageModelV4`, and as the
   * seam for a future `wrapLanguageModel` middleware. Production callers should
   * leave it unset and get `HAIKU_MODEL_ID`.
   */
  model?: LanguageModel;
  abortSignal?: AbortSignal;
  headers?: Record<string, string | undefined>;
  providerOptions?: ProviderOptions;
}

/**
 * `LanguageModelCallOptions` carries the sampling settings (`temperature`,
 * `maxOutputTokens`, …) and `Prompt` carries `instructions` / `prompt` /
 * `messages`. Neither contains a single tool-related key, so the surface a
 * caller sees is tool-free by construction as well as by the `never`s above.
 */
export type LlmCallOptions = LanguageModelCallOptions &
  Prompt &
  LlmRequestContext &
  NoTools &
  OwnedByPolicy;

export type LlmStructuredCallOptions<OBJECT> = LlmCallOptions & {
  /** Zod v4 schemas work directly — `FlexibleSchema` accepts them. */
  schema: FlexibleSchema<OBJECT>;
  /** Optional name/description passed to the provider as schema guidance. */
  schemaName?: string;
  schemaDescription?: string;
};

/**
 * Split caller-supplied wrapper concerns from the settings that go to the SDK.
 * Everything left in `settings` is a sampling setting or a prompt field.
 *
 * Exported so `client.test.ts` can assert the exact object the SDK receives —
 * the model id, the retry budget, the timeout budget, and the *absence* of any
 * tool key — without a network call. Not part of the intended call surface.
 */
export function buildSdkOptions(options: LlmCallOptions) {
  const {
    purpose,
    runId,
    sink,
    cacheHit,
    guardRejected,
    model,
    abortSignal,
    headers,
    providerOptions,
    ...settings
  } = options;

  const policy = policyFor(purpose);
  const resolvedModel = model ?? HAIKU_MODEL_ID;

  const context: LlmCallContext = {
    purpose,
    // The record wants the model id we asked for. When `model` is an injected
    // model instance rather than a gateway slug, fall back to its own id.
    model:
      typeof resolvedModel === "string"
        ? resolvedModel
        : resolvedModel.modelId,
    runId: runId ?? null,
    cacheHit,
    guardRejected,
  };

  return {
    policy,
    context,
    sink: sink ?? noopLlmCallSink,
    /** Options common to every call this module makes. */
    shared: {
      // Policy defaults first, so a call site can raise `maxOutputTokens` for a
      // legitimately longer answer.
      maxOutputTokens: policy.maxOutputTokens,
      temperature: policy.temperature,
      // Caller-supplied sampling settings and the prompt, with every tool and
      // policy key removed.
      ...stripReservedKeys(settings),
      // Last, so nothing a caller sent can displace them.
      model: resolvedModel,
      maxRetries: policy.maxRetries,
      // `timeout` as a bare number is the total budget for the whole call,
      // retries and backoff included. It is a first-class v7 option — the SDK
      // turns it into `AbortSignal.timeout(ms)`, so there is nothing to
      // hand-roll here.
      timeout: policy.timeoutMs,
      abortSignal,
      headers,
      providerOptions,
    },
  };
}

/**
 * A sink must never break the caller. Telemetry that throws would turn a
 * successful recommendation into a 500.
 */
function emit(sink: LlmCallSink, record: LlmCallRecord): void {
  try {
    const maybePromise = sink(record);
    if (maybePromise && typeof maybePromise.then === "function") {
      void maybePromise.then(undefined, reportSinkFailure);
    }
  } catch (cause) {
    reportSinkFailure(cause);
  }
}

function reportSinkFailure(cause: unknown): void {
  console.error("[ai] llm_calls sink failed", cause);
}

/**
 * A single non-streaming completion.
 *
 * Rejects on failure (after `policy.maxRetries` retries or `policy.timeoutMs`,
 * whichever comes first) and emits exactly one `LlmCallRecord` either way.
 */
export async function generateNarrative(options: LlmCallOptions) {
  const { context, sink, shared } = buildSdkOptions(options);
  let recorded = false;

  try {
    return await generateText({
      ...shared,
      onLanguageModelCallEnd: (event) => {
        recorded = true;
        emit(sink, recordFromCallEndEvent(event, context));
      },
    });
  } catch (error) {
    // The provider call threw, so `onLanguageModelCallEnd` never fired; the
    // `recorded` guard only exists for the case where it did.
    if (!recorded) emit(sink, errorRecord(error, context));
    throw error;
  }
}

/**
 * A streamed completion. Returns **synchronously** — `streamText` is not a
 * promise in AI SDK v7; awaiting it would be a no-op that hides the streaming.
 *
 * Telemetry is wired to `onLanguageModelCallEnd` / `onError` / `onAbort` rather
 * than to `result.usage`, because `result.usage` never settles if the consumer
 * disconnects before draining `textStream` — losing exactly the abandoned calls
 * that are most worth metering.
 */
export function streamNarrative(options: LlmCallOptions) {
  const { context, sink, shared } = buildSdkOptions(options);
  let recorded = false;

  const record = (build: () => LlmCallRecord) => {
    if (recorded) return;
    recorded = true;
    emit(sink, build());
  };

  return streamText({
    ...shared,
    onLanguageModelCallEnd: (event) =>
      record(() => recordFromCallEndEvent(event, context)),
    onError: ({ error }) => record(() => errorRecord(error, context)),
    onAbort: () =>
      record(() => errorRecord(new Error("stream aborted"), context)),
  });
}

/**
 * A schema-constrained completion, for turning free text into a structured
 * profile.
 *
 * Uses `generateText` with `Output.object` rather than `generateObject`: in
 * ai@7 `generateObject` is deprecated *and* omits `timeout` from its options,
 * so it cannot honour this module's timeout policy.
 *
 * Read the parsed value from `result.output`. It throws `NoOutputGeneratedError`
 * if the model stopped before producing a complete object.
 */
export async function generateStructured<OBJECT>(
  options: LlmStructuredCallOptions<OBJECT>,
) {
  const { schema, schemaName, schemaDescription, ...rest } = options;
  const { context, sink, shared } = buildSdkOptions(rest);
  let recorded = false;

  try {
    return await generateText({
      ...shared,
      output: Output.object<OBJECT>({
        schema,
        name: schemaName,
        description: schemaDescription,
      }),
      onLanguageModelCallEnd: (event) => {
        recorded = true;
        emit(sink, recordFromCallEndEvent(event, context));
      },
    });
  } catch (error) {
    if (!recorded) emit(sink, errorRecord(error, context));
    throw error;
  }
}
