import { afterEach, describe, expect, it } from "vitest";

import {
  GATEWAY_MODEL_ID_PATTERN,
  HAIKU_MODEL_ID,
  LLM_POLICIES,
  LLM_PURPOSES,
  hasGatewayCredentials,
  policyFor,
} from "./config";

describe("HAIKU_MODEL_ID", () => {
  it("is the gateway slug, with a dot rather than a hyphen", () => {
    // The bd issue text says `anthropic/claude-haiku-4-5`, which is the
    // Anthropic first-party API id. The gateway's own `GatewayModelId` union in
    // @ai-sdk/gateway@4.0.62 enumerates only `anthropic/claude-haiku-4.5`.
    // That union ends in `(string & {})`, so a wrong slug typechecks and fails
    // only at request time — this assertion is the only guard there is.
    expect(HAIKU_MODEL_ID).toBe("anthropic/claude-haiku-4.5");
  });

  it("is a bare creator/model-name string, which is what routes via the gateway", () => {
    expect(HAIKU_MODEL_ID).toMatch(GATEWAY_MODEL_ID_PATTERN);
    expect(HAIKU_MODEL_ID.split("/")).toHaveLength(2);
  });
});

describe("LLM_PURPOSES", () => {
  it("mirrors the values documented on llm_calls.purpose", () => {
    // `purpose` is plain `text` in src/db/schema/users.ts — there is no pg enum
    // to import — so this tuple is the only machine-readable copy. Drift here
    // means rows the analytics queries silently miss.
    expect([...LLM_PURPOSES]).toEqual([
      "recommendation_narrative",
      "profile_parse",
      "e20_guidance",
      "extraction",
    ]);
  });

  it("has no duplicates", () => {
    expect(new Set(LLM_PURPOSES).size).toBe(LLM_PURPOSES.length);
  });
});

describe("LLM_POLICIES", () => {
  it("covers every purpose and nothing else", () => {
    expect(Object.keys(LLM_POLICIES).sort()).toEqual([...LLM_PURPOSES].sort());
  });

  it.each(LLM_PURPOSES)("%s has a usable budget", (purpose) => {
    const policy = policyFor(purpose);
    expect(policy.timeoutMs).toBeGreaterThan(0);
    expect(policy.maxRetries).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(policy.maxRetries)).toBe(true);
    expect(policy.maxOutputTokens).toBeGreaterThan(0);
    expect(policy.temperature).toBeGreaterThanOrEqual(0);
  });

  it("keeps interactive purposes inside their timeout even in the worst retry case", () => {
    // The SDK's backoff is a hardcoded 2000ms initial delay with a factor of 2
    // and is NOT reachable from generateText/streamText options. A policy whose
    // retries alone exceed its timeout can never actually use its last retry.
    for (const purpose of LLM_PURPOSES) {
      const { maxRetries, timeoutMs } = policyFor(purpose);
      let backoffMs = 0;
      for (let attempt = 0; attempt < maxRetries; attempt += 1) {
        backoffMs += 2_000 * 2 ** attempt;
      }
      expect(
        backoffMs,
        `${purpose}: ${backoffMs}ms of backoff does not fit in a ${timeoutMs}ms budget`,
      ).toBeLessThan(timeoutMs);
    }
  });

  it("uses temperature 0 where the output is parsed rather than read", () => {
    expect(policyFor("profile_parse").temperature).toBe(0);
    expect(policyFor("extraction").temperature).toBe(0);
  });
});

describe("hasGatewayCredentials", () => {
  const original = {
    apiKey: process.env.AI_GATEWAY_API_KEY,
    oidc: process.env.VERCEL_OIDC_TOKEN,
  };

  afterEach(() => {
    if (original.apiKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = original.apiKey;
    if (original.oidc === undefined) delete process.env.VERCEL_OIDC_TOKEN;
    else process.env.VERCEL_OIDC_TOKEN = original.oidc;
  });

  it("returns false without throwing when nothing is configured", () => {
    delete process.env.AI_GATEWAY_API_KEY;
    delete process.env.VERCEL_OIDC_TOKEN;
    expect(hasGatewayCredentials()).toBe(false);
  });

  it("accepts either an explicit key or a Vercel OIDC token", () => {
    delete process.env.AI_GATEWAY_API_KEY;
    process.env.VERCEL_OIDC_TOKEN = "oidc-token";
    expect(hasGatewayCredentials()).toBe(true);

    delete process.env.VERCEL_OIDC_TOKEN;
    process.env.AI_GATEWAY_API_KEY = "key";
    expect(hasGatewayCredentials()).toBe(true);
  });

  it("treats an empty string as absent", () => {
    process.env.AI_GATEWAY_API_KEY = "";
    process.env.VERCEL_OIDC_TOKEN = "";
    expect(hasGatewayCredentials()).toBe(false);
  });
});
