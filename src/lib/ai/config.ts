/**
 * Every knob for the LLM layer, in one place.
 *
 * Carbon Miles routes all model traffic through the Vercel AI Gateway using a
 * plain `"creator/model-name"` string. There is deliberately no provider
 * package (`@ai-sdk/anthropic` or similar) in `package.json`: passing the bare
 * string is what makes the gateway the single egress point, and it defers all
 * credential loading to request time, so this module can be imported — and
 * type-checked, and unit-tested — with no API key present.
 */

/**
 * The one place the model id lives.
 *
 * `anthropic/claude-haiku-4.5` is the only Anthropic Haiku slug enumerated in
 * `GatewayModelId` in the installed `@ai-sdk/gateway@4.0.62` typings. Note the
 * **dot**: the Anthropic first-party API id is `claude-haiku-4-5` (hyphen), but
 * gateway slugs use the dotted marketing version. Because `GatewayModelId`
 * terminates in `(string & {})`, both forms typecheck and a wrong slug only
 * fails at request time as a gateway 404 — hence this single constant.
 */
export const HAIKU_MODEL_ID = "anthropic/claude-haiku-4.5";

/**
 * The gateway's model-id contract: `creator/model-name`.
 * Asserted in `config.test.ts` so a typo cannot ship silently.
 */
export const GATEWAY_MODEL_ID_PATTERN = /^[a-z0-9-]+\/[a-z0-9._-]+$/;

/**
 * Mirrors the `purpose` values documented on `llm_calls.purpose` in
 * `src/db/schema/users.ts`. That column is plain `text` — there is no pg enum
 * to import — so this tuple is the only machine-readable copy, and
 * `config.test.ts` pins it. Same discipline as `src/lib/engine/enums.ts`.
 */
export const LLM_PURPOSES = [
  "recommendation_narrative",
  "profile_parse",
  "e20_guidance",
  "extraction",
] as const;

export type LlmPurpose = (typeof LLM_PURPOSES)[number];

export interface LlmCallPolicy {
  /**
   * Forwarded to `RequestOptions.maxRetries`. 0 disables retries.
   *
   * Keep this small for interactive purposes. The AI SDK's backoff floor is a
   * hardcoded 2000 ms with a factor of 2 and is *not* reachable from
   * `generateText`/`streamText` options, so `maxRetries: 3` can silently add
   * ~14 s of sleep before `timeoutMs` even fires.
   */
  readonly maxRetries: number;
  /** Forwarded to `RequestOptions.timeout` (number form => total budget). */
  readonly timeoutMs: number;
  readonly maxOutputTokens: number;
  readonly temperature: number;
}

/**
 * Tunable defaults, not measured facts. They encode the product's latency
 * budget: the narrative streams *behind* an already-rendered deterministic
 * result, so it can afford to be slow; profile parsing blocks the user, so it
 * cannot; extraction runs offline during ingestion, so it can be generous.
 */
export const LLM_POLICIES: Readonly<Record<LlmPurpose, LlmCallPolicy>> = {
  recommendation_narrative: {
    maxRetries: 2,
    timeoutMs: 20_000,
    maxOutputTokens: 1_500,
    temperature: 0.3,
  },
  profile_parse: {
    maxRetries: 1,
    timeoutMs: 8_000,
    maxOutputTokens: 800,
    temperature: 0,
  },
  e20_guidance: {
    maxRetries: 2,
    timeoutMs: 20_000,
    maxOutputTokens: 1_500,
    temperature: 0.2,
  },
  extraction: {
    maxRetries: 3,
    timeoutMs: 60_000,
    maxOutputTokens: 4_000,
    temperature: 0,
  },
};

export function policyFor(purpose: LlmPurpose): LlmCallPolicy {
  return LLM_POLICIES[purpose];
}

/**
 * Non-throwing health probe. The gateway resolves credentials itself at request
 * time (`AI_GATEWAY_API_KEY`, else Vercel OIDC), so nothing in this module may
 * read `process.env` at module scope — doing so would break `pnpm typecheck`
 * and `pnpm test` on machines with no key.
 */
export function hasGatewayCredentials(): boolean {
  // `||`, not `??`: an env var set to the empty string is absent in practice,
  // and `vercel env pull` will happily write one.
  return Boolean(
    process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN,
  );
}
