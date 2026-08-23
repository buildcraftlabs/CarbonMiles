/**
 * Public surface of the LLM layer.
 *
 * Named re-exports only — no `export *`. The package has no `"type": "module"`,
 * so files under `src/` that an `.mts` script imports transpile to CommonJS and
 * a star re-export becomes a runtime call Node's ESM lexer cannot see, silently
 * dropping the names at the import site.
 *
 * `./llm-call-recorder` is intentionally absent: re-exporting it would drag
 * `src/db/client.ts` — which throws without `DATABASE_URL` — into the module
 * graph of everything that imports this barrel. Import it directly where a real
 * database is known to exist.
 */

export {
  GATEWAY_MODEL_ID_PATTERN,
  HAIKU_MODEL_ID,
  LLM_POLICIES,
  LLM_PURPOSES,
  hasGatewayCredentials,
  policyFor,
  type LlmCallPolicy,
  type LlmPurpose,
} from "./config";

export {
  describeError,
  errorRecord,
  extractGenerationId,
  noopLlmCallSink,
  recordFromCallEndEvent,
  usageToTokenCounts,
  usdToMicroUsd,
  type LlmCallContext,
  type LlmCallRecord,
  type LlmCallSink,
  type TokenCounts,
} from "./telemetry";

export {
  generateNarrative,
  generateStructured,
  streamNarrative,
  type LlmCallOptions,
  type LlmRequestContext,
  type LlmStructuredCallOptions,
} from "./client";
