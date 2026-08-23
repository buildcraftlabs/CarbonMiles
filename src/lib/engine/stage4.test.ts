import { describe, expect, it } from "vitest";

import type { CandidateVariant } from "./candidate";
import type { FuelType } from "./enums";
import type { OnRoadFactors, OnRoadPrice } from "./on-road";
import type { ScoredCandidate, ScoringInput } from "./stage3";
import {
  DEFAULT_RESULT_LIMIT,
  MAX_VARIANTS_PER_MODEL,
  runStage4,
  type Stage4Input,
} from "./stage4";
import type { TcoBreakdown } from "./tco";

const lakhs = (n: number) => Math.round(n * 10_000_000);

const onRoadFactors: OnRoadFactors = {
  stateCode: "MH",
  category: "passenger",
  fuelType: null,
  priceBandMinPaise: 0,
  priceBandMaxPaise: null,
  roadTaxPct: 11,
  registrationFeePaise: 60_000,
  insurancePct: 3,
  otherLevyPaise: 0,
  effectiveFrom: "2026-04-01",
};

const price: OnRoadPrice = {
  exShowroomPaise: lakhs(8),
  roadTaxPaise: lakhs(0.88),
  registrationFeePaise: 60_000,
  insurancePaise: lakhs(0.24),
  otherLevyPaise: 0,
  onRoadPaise: lakhs(9.12) + 60_000,
  factors: onRoadFactors,
};

const tco = (variantId: string): TcoBreakdown => ({
  variantId,
  ownershipYears: 5,
  totalKm: 72_000,
  acquisitionPaise: lakhs(9),
  energyPaise: lakhs(3),
  maintenancePaise: lakhs(1),
  insuranceRenewalPaise: 50_000_000,
  financingInterestPaise: 0,
  batteryReplacementPaise: 0,
  resaleNominalPaise: lakhs(4),
  resaleCreditPaise: lakhs(3),
  totalPaise: lakhs(12),
  costPaisePerKm: lakhs(12) / 72_000,
  yearly: [],
  assumptions: [],
});

const variant = (
  variantId: string,
  modelId: string,
  fuelType: FuelType = "petrol",
): CandidateVariant => ({
  variantId,
  modelId,
  name: `${variantId} (${modelId})`,
  category: "passenger",
  bodyType: "hatchback",
  status: "active",
  fuelType,
  exShowroomPaise: lakhs(8),
  seatingCapacity: 5,
  payloadKg: null,
  realWorldRangeKm: null,
  availableInState: true,
});

const scored = (variantId: string, totalScore: number): ScoredCandidate => ({
  variantId,
  name: variantId,
  totalScore,
  subScores: [],
  unscored: [],
});

/**
 * Builds an aligned candidate/score pair set from a compact spec, the way
 * stage 3 hands it over: same order, same length.
 */
const build = (
  spec: readonly [id: string, model: string, fuel: FuelType, score: number][],
  limit?: number,
): Stage4Input => {
  const candidates: ScoringInput[] = spec.map(([id, model, fuel]) => ({
    variant: variant(id, model, fuel),
    price,
    tco: tco(id),
    co2: null,
    commercial: null,
    serviceCentreCount: null,
    resaleLiquidityScore: null,
  }));

  return {
    candidates,
    scored: spec.map(([id, , , score]) => scored(id, score)),
    ...(limit === undefined ? {} : { limit }),
  };
};

const run = (input: Stage4Input) => {
  const result = runStage4(input);
  if (!result.ok) throw new Error(`stage 4 failed: ${result.reason}`);
  return result;
};

describe("runStage4 ordering", () => {
  it("ranks by score, highest first", () => {
    const { ranked } = run(
      build([
        ["a", "m1", "petrol", 60],
        ["b", "m2", "petrol", 90],
        ["c", "m3", "petrol", 75],
      ]),
    );

    expect(ranked.map((r) => r.variantId)).toEqual(["b", "c", "a"]);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  it("marks the highest scorer as the top pick", () => {
    const { ranked } = run(
      build([
        ["a", "m1", "petrol", 60],
        ["b", "m2", "petrol", 90],
      ]),
    );

    expect(ranked[0].selectedBy).toBe("top_pick");
    expect(ranked[1].selectedBy).toBe("score");
  });

  it("breaks ties on variant id so a stored run replays identically", () => {
    const input = build([
      ["zeta", "m1", "petrol", 80],
      ["alpha", "m2", "petrol", 80],
    ]);

    expect(run(input).ranked.map((r) => r.variantId)).toEqual(["alpha", "zeta"]);
    expect(run(input)).toEqual(run(input));
  });

  it("caps the list at the default of five", () => {
    const { ranked } = run(
      build(
        Array.from({ length: 8 }, (_, i) => [
          `v${i}`,
          `m${i}`,
          "petrol",
          100 - i,
        ]) as [string, string, FuelType, number][],
      ),
    );

    expect(ranked).toHaveLength(DEFAULT_RESULT_LIMIT);
  });

  it("honours an explicit limit", () => {
    const { ranked } = run(
      build(
        [
          ["a", "m1", "petrol", 90],
          ["b", "m2", "petrol", 80],
          ["c", "m3", "petrol", 70],
        ],
        2,
      ),
    );

    expect(ranked).toHaveLength(2);
  });

  it("returns an empty list rather than failing when nothing survived", () => {
    const result = run({ candidates: [], scored: [] });

    expect(result.ranked).toEqual([]);
    expect(result.omitted).toEqual([]);
  });
});

describe("runStage4 model cap", () => {
  it("takes at most two variants of any one model", () => {
    const { ranked } = run(
      build([
        ["a1", "m1", "petrol", 95],
        ["a2", "m1", "petrol", 94],
        ["a3", "m1", "petrol", 93],
        ["a4", "m1", "petrol", 92],
        ["b1", "m2", "petrol", 50],
      ]),
    );

    const fromM1 = ranked.filter((r) => r.modelId === "m1");
    expect(fromM1).toHaveLength(MAX_VARIANTS_PER_MODEL);
    expect(ranked.map((r) => r.variantId)).toContain("b1");
  });

  it("reports each capped variant with its reason", () => {
    const { omitted } = run(
      build([
        ["a1", "m1", "petrol", 95],
        ["a2", "m1", "petrol", 94],
        ["a3", "m1", "petrol", 93],
        ["b1", "m2", "petrol", 50],
      ]),
    );

    const capped = omitted.filter((o) => o.code === "model_cap");
    expect(capped.map((o) => o.variantId)).toEqual(["a3"]);
    expect(capped[0].reason).toContain("Two variants of this model");
  });

  it("still lets the top pick through when its model is the crowded one", () => {
    const { ranked } = run(
      build([
        ["a1", "m1", "petrol", 99],
        ["a2", "m1", "petrol", 98],
        ["a3", "m1", "petrol", 97],
      ]),
    );

    expect(ranked[0].variantId).toBe("a1");
    expect(ranked[0].selectedBy).toBe("top_pick");
    expect(ranked).toHaveLength(2);
  });

  it("says so when the cap leaves fewer than three vehicles to show", () => {
    const { assumptions } = run(
      build([
        ["a1", "m1", "petrol", 99],
        ["a2", "m1", "petrol", 98],
        ["a3", "m1", "petrol", 97],
      ]),
    );

    expect(assumptions.join(" ")).toContain("Fewer than three vehicles");
  });
});

describe("runStage4 fuel diversity", () => {
  it("promotes a second powertrain over a higher-scoring same-fuel vehicle", () => {
    const { ranked } = run(
      build(
        [
          ["p1", "m1", "petrol", 90],
          ["p2", "m2", "petrol", 80],
          ["e1", "m3", "electric", 40],
        ],
        2,
      ),
    );

    expect(ranked.map((r) => r.variantId)).toEqual(["p1", "e1"]);
    expect(ranked[1].selectedBy).toBe("fuel_diversity");
  });

  it("explains the displaced vehicle rather than dropping it silently", () => {
    const { omitted } = run(
      build(
        [
          ["p1", "m1", "petrol", 90],
          ["p2", "m2", "petrol", 80],
          ["e1", "m3", "electric", 40],
        ],
        2,
      ),
    );

    const displaced = omitted.find(
      (o) => o.code === "displaced_for_fuel_diversity",
    );
    expect(displaced?.variantId).toBe("p2");
    expect(displaced?.reason).toContain("electric");
  });

  it("never displaces the top pick", () => {
    const { ranked } = run(
      build(
        [
          ["p1", "m1", "petrol", 90],
          ["e1", "m2", "electric", 20],
        ],
        1,
      ),
    );

    // A single-slot list cannot diversify without giving up the winner, so it
    // keeps the winner.
    expect(ranked.map((r) => r.variantId)).toEqual(["p1"]);
  });

  it("leaves a list alone when it already holds two powertrains", () => {
    const { ranked, omitted } = run(
      build([
        ["p1", "m1", "petrol", 90],
        ["d1", "m2", "diesel", 85],
        ["e1", "m3", "electric", 10],
      ]),
    );

    expect(ranked.map((r) => r.variantId)).toEqual(["p1", "d1", "e1"]);
    expect(
      omitted.some((o) => o.code === "displaced_for_fuel_diversity"),
    ).toBe(false);
  });

  it("does not invent diversity when the pool holds only one fuel", () => {
    const { ranked, assumptions } = run(
      build(
        [
          ["p1", "m1", "petrol", 90],
          ["p2", "m2", "petrol", 80],
          ["p3", "m3", "petrol", 70],
        ],
        2,
      ),
    );

    expect(ranked.map((r) => r.variantId)).toEqual(["p1", "p2"]);
    expect(assumptions.join(" ")).toContain("no second powertrain");
  });

  it("re-orders after a promotion so ranks still follow score", () => {
    const { ranked } = run(
      build(
        [
          ["p1", "m1", "petrol", 90],
          ["p2", "m2", "petrol", 50],
          ["e1", "m3", "electric", 70],
        ],
        2,
      ),
    );

    expect(ranked.map((r) => r.variantId)).toEqual(["p1", "e1"]);
    expect(ranked.map((r) => r.totalScore)).toEqual([90, 70]);
  });
});

describe("runStage4 accounting", () => {
  it("flags the best scorer of each fuel type across the whole pool", () => {
    const { ranked } = run(
      build([
        ["p1", "m1", "petrol", 90],
        ["p2", "m2", "petrol", 80],
        ["e1", "m3", "electric", 70],
      ]),
    );

    expect(ranked.find((r) => r.variantId === "p1")?.bestInFuel).toBe(true);
    expect(ranked.find((r) => r.variantId === "p2")?.bestInFuel).toBe(false);
    expect(ranked.find((r) => r.variantId === "e1")?.bestInFuel).toBe(true);
  });

  it("accounts for every candidate exactly once", () => {
    const spec: [string, string, FuelType, number][] = [
      ["a1", "m1", "petrol", 95],
      ["a2", "m1", "petrol", 94],
      ["a3", "m1", "petrol", 93],
      ["b1", "m2", "diesel", 60],
      ["c1", "m3", "petrol", 55],
      ["d1", "m4", "petrol", 50],
      ["e1", "m5", "petrol", 45],
    ];
    const { ranked, omitted } = run(build(spec));

    const seen = [...ranked.map((r) => r.variantId), ...omitted.map((o) => o.variantId)];
    expect(seen.sort()).toEqual(spec.map(([id]) => id).sort());
    expect(new Set(seen).size).toBe(spec.length);
  });

  it("reports the merely outscored with the score they lost to", () => {
    const { omitted } = run(
      build(
        [
          ["a", "m1", "petrol", 90],
          ["b", "m2", "petrol", 80],
          ["c", "m3", "petrol", 30],
        ],
        2,
      ),
    );

    const outscored = omitted.find((o) => o.code === "outscored");
    expect(outscored?.variantId).toBe("c");
    expect(outscored?.reason).toContain("80");
  });
});

describe("runStage4 input pairing", () => {
  it("refuses a candidate list and score list of different lengths", () => {
    const input = build([
      ["a", "m1", "petrol", 90],
      ["b", "m2", "petrol", 80],
    ]);
    const result = runStage4({ ...input, scored: input.scored.slice(0, 1) });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("candidates_misaligned");
  });

  it("refuses a misaligned pair rather than ranking one vehicle under another's name", () => {
    const input = build([
      ["a", "m1", "petrol", 90],
      ["b", "m2", "petrol", 80],
    ]);
    const result = runStage4({
      ...input,
      scored: [...input.scored].reverse(),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("Position 0");
  });
});
