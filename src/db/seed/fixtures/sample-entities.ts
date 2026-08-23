import type { SeedEntity } from "../provenance";

/**
 * Fixtures for the seed format. Every value here is visibly synthetic.
 *
 * This file exists to exercise the *mechanism* — identity vs facts, per-field
 * sources, nulls, jsonb, paise, numerics that Postgres pads. It contains no
 * vehicle data and must never contain any: a plausible-looking efficiency
 * figure in a fixture is a fabricated number one copy-paste away from the
 * catalogue. The source slugs are fictional (`fixture-source`,
 * `fixture-source-b`) so that they cannot resolve against a real `sources` row
 * even by accident.
 */
export type FixtureVariantInsert = {
  slug: string;
  modelId: string;
  name: string;
  status: "active" | "discontinued" | "upcoming";
  /** numeric(6,2) — Postgres reads it back zero-padded, e.g. "12.00". */
  realWorldEfficiencyCity: string | null;
  /** bigint paise. Never rupees, never a float. */
  exShowroomPaise: number | null;
  knownAdvantages: string[];
};

export const FIXTURE_MODEL_ID = "00000000-0000-4000-8000-000000000001";

export const FIXTURE_ENTITIES: readonly SeedEntity<FixtureVariantInsert>[] = [
  {
    key: "fixture-variant-a",
    identity: {
      slug: "fixture-variant-a",
      modelId: FIXTURE_MODEL_ID,
      name: "Fixture Variant A",
      status: "active",
    },
    facts: {
      realWorldEfficiencyCity: {
        value: "12",
        source: "fixture-source",
        verifiedAt: "2026-01-15",
        confidence: "high",
        sourceUrl: "https://fixture.invalid/a",
        excerpt: "Fixture excerpt A.",
      },
      exShowroomPaise: {
        value: 100_000_00,
        source: "fixture-source",
        verifiedAt: "2026-01-15",
      },
      knownAdvantages: {
        value: ["fixture-advantage-1", "fixture-advantage-2"],
        source: "fixture-source-b",
        verifiedAt: "2026-02-01",
        confidence: "low",
      },
    },
  },
  {
    /**
     * The known-absent case. A fact whose value is null still carries evidence:
     * "we looked, and this source does not publish it" is a different claim
     * from "nobody has looked", and only the first one belongs in the database.
     */
    key: "fixture-variant-b",
    identity: {
      slug: "fixture-variant-b",
      modelId: FIXTURE_MODEL_ID,
      name: "Fixture Variant B",
      status: "active",
    },
    facts: {
      realWorldEfficiencyCity: {
        value: null,
        source: "fixture-source",
        verifiedAt: "2026-02-01",
        confidence: "low",
        excerpt: "Fixture source publishes no city figure for this configuration.",
      },
    },
  },
];
