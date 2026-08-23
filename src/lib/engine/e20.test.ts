import { describe, expect, it } from "vitest";

import {
  assessE20,
  E20_RULES,
  meetsRiskFloor,
  selectCompatibilityRow,
  selectGuidance,
  type AssessedVehicle,
  type E20AssessmentInput,
  type E20CompatibilityRecord,
  type E20GuidanceRule,
} from "./e20";
import { E20_VERDICTS, EMISSION_NORMS, RISK_LEVELS } from "./enums";

const vehicle = (over: Partial<AssessedVehicle> = {}): AssessedVehicle => ({
  variantId: "v1",
  modelId: "m1",
  name: "Test Hatch VXi",
  bodyType: "hatchback",
  fuelType: "petrol",
  emissionNorm: "bs6_phase2",
  manufactureYear: 2024,
  odometerKm: 30_000,
  ...over,
});

const compat = (
  over: Partial<E20CompatibilityRecord> = {},
): E20CompatibilityRecord => ({
  id: "c1",
  modelId: "m1",
  variantId: null,
  appliesFrom: null,
  appliesTo: null,
  verdict: "e20_compliant",
  materialRiskLevel: "none",
  mileageDeltaMinPct: 1,
  mileageDeltaMaxPct: 2,
  oemStatementUrl: null,
  oemStatementSummary: null,
  sourceId: "s1",
  confidence: "high",
  inferredFromNorm: false,
  ...over,
});

const guidance = (over: Partial<E20GuidanceRule> = {}): E20GuidanceRule => ({
  id: "g1",
  kind: "inspection",
  appliesToVerdict: "e10_only",
  minRiskLevel: "none",
  appliesToBodyTypes: [],
  appliesToMaxYear: null,
  title: "Inspect fuel lines",
  detail: "Check for softening or weeping at every joint.",
  priority: 10,
  sourceId: "s2",
  ...over,
});

const inputOf = (over: Partial<E20AssessmentInput> = {}): E20AssessmentInput => ({
  vehicle: vehicle(),
  compatibility: [],
  guidanceRules: [],
  asOfYear: 2026,
  ...over,
});

describe("fuel type settles the question first", () => {
  it.each(["diesel", "electric", "hydrogen"] as const)(
    "%s is not_applicable, whatever the table says",
    (fuelType) => {
      const result = assessE20(
        inputOf({
          vehicle: vehicle({ fuelType }),
          // A row claiming otherwise must not be able to override physics.
          compatibility: [compat({ verdict: "e10_only", materialRiskLevel: "high" })],
        }),
      );
      expect(result.verdict).toBe("not_applicable");
      expect(result.basis).toBe("fuel_type");
      expect(result.materialRiskLevel).toBe("none");
      expect(result.mileageDelta).toBeNull();
      expect(result.guidance).toEqual([]);
    },
  );

  it("flex-fuel is compliant by construction when no row exists", () => {
    const result = assessE20(
      inputOf({ vehicle: vehicle({ fuelType: "flex_fuel", emissionNorm: "bs4" }) }),
    );
    expect(result.verdict).toBe("e20_compliant");
    expect(result.basis).toBe("fuel_type");
    expect(result.inferredFromNorm).toBe(false);
    // The BS-IV norm rule would have said e10_only. Construction outranks it.
    expect(result.confidence).toBe("high");
  });

  it("a row still outranks the flex-fuel default", () => {
    const result = assessE20(
      inputOf({
        vehicle: vehicle({ fuelType: "flex_fuel" }),
        compatibility: [compat({ verdict: "e20_tolerant" })],
      }),
    );
    expect(result.verdict).toBe("e20_tolerant");
    expect(result.basis).toBe("oem_statement");
  });

  it("bi-fuel CNG is assessed on petrol, and says so", () => {
    const result = assessE20(
      inputOf({ vehicle: vehicle({ fuelType: "cng" }) }),
    );
    expect(result.verdict).not.toBe("not_applicable");
    expect(result.assumptions.join(" ")).toContain("bi-fuel");
  });
});

describe("row selection (FR-B2, FR-B3)", () => {
  it("prefers a variant-scoped row over a model-scoped one", () => {
    const model = compat({ id: "model", verdict: "e10_only" });
    const variantRow = compat({
      id: "variant",
      modelId: null,
      variantId: "v1",
      verdict: "e20_compliant",
    });
    const picked = selectCompatibilityRow([model, variantRow], vehicle());
    expect(picked?.id).toBe("variant");
  });

  it("ignores a row scoped to a different variant", () => {
    const other = compat({ id: "other", modelId: null, variantId: "v2" });
    expect(selectCompatibilityRow([other], vehicle())).toBeNull();
  });

  it("ignores a row scoped to a different model", () => {
    const other = compat({ id: "other", modelId: "m2" });
    expect(selectCompatibilityRow([other], vehicle())).toBeNull();
  });

  it("excludes a row whose window ends before the manufacture year", () => {
    const stale = compat({ appliesFrom: "2015-01-01", appliesTo: "2019-12-31" });
    expect(
      selectCompatibilityRow([stale], vehicle({ manufactureYear: 2024 })),
    ).toBeNull();
  });

  it("excludes a row whose window starts after the manufacture year", () => {
    const future = compat({ appliesFrom: "2025-04-01", appliesTo: null });
    expect(
      selectCompatibilityRow([future], vehicle({ manufactureYear: 2024 })),
    ).toBeNull();
  });

  it("keeps a row that overlaps the manufacture year only partly", () => {
    const midYear = compat({ appliesFrom: "2023-04-01", appliesTo: null });
    expect(
      selectCompatibilityRow([midYear], vehicle({ manufactureYear: 2023 }))?.id,
    ).toBe("c1");
  });

  it("declares the ambiguity when the overlap is partial", () => {
    const result = assessE20(
      inputOf({
        vehicle: vehicle({ manufactureYear: 2023 }),
        compatibility: [compat({ appliesFrom: "2023-04-01", appliesTo: null })],
      }),
    );
    expect(result.assumptions.join(" ")).toContain("only part of 2023");
  });

  it("says nothing about ambiguity when the window covers the whole year", () => {
    const result = assessE20(
      inputOf({
        compatibility: [compat({ appliesFrom: "2020-01-01", appliesTo: "2030-12-31" })],
      }),
    );
    expect(result.assumptions.join(" ")).not.toContain("only part of");
  });

  it("prefers a stated OEM position over a norm-inferred row at the same scope", () => {
    const inferred = compat({ id: "a-inferred", inferredFromNorm: true });
    const stated = compat({ id: "z-stated", inferredFromNorm: false });
    expect(selectCompatibilityRow([inferred, stated], vehicle())?.id).toBe(
      "z-stated",
    );
  });

  it("prefers higher confidence when scope and provenance tie", () => {
    const low = compat({ id: "a-low", confidence: "low" });
    const high = compat({ id: "z-high", confidence: "high" });
    expect(selectCompatibilityRow([low, high], vehicle())?.id).toBe("z-high");
  });

  it("prefers the narrower window when all else ties", () => {
    const wide = compat({
      id: "a-wide",
      appliesFrom: "2010-01-01",
      appliesTo: "2030-01-01",
    });
    const narrow = compat({
      id: "z-narrow",
      appliesFrom: "2024-01-01",
      appliesTo: "2024-12-31",
    });
    expect(selectCompatibilityRow([wide, narrow], vehicle())?.id).toBe("z-narrow");
  });

  it("breaks a total tie on id, so two runs cannot disagree", () => {
    const a = compat({ id: "aaa" });
    const b = compat({ id: "bbb" });
    expect(selectCompatibilityRow([a, b], vehicle())?.id).toBe("aaa");
    expect(selectCompatibilityRow([b, a], vehicle())?.id).toBe("aaa");
  });
});

describe("the norm rule fires only when no row applies (FR-B4)", () => {
  it.each([
    ["bs3", "e10_only", "high"],
    ["bs4", "e10_only", "moderate"],
    ["bs6_phase1", "e20_tolerant", "low"],
    ["bs6_phase2", "e20_compliant", "none"],
  ] as const)("%s infers %s at %s risk", (norm, verdict, risk) => {
    const result = assessE20(
      inputOf({
        vehicle: vehicle({ emissionNorm: norm, manufactureYear: 2020 }),
      }),
    );
    expect(result.verdict).toBe(verdict);
    expect(result.baseRiskLevel).toBe(risk);
    expect(result.basis).toBe("inferred_from_norm");
    expect(result.inferredFromNorm).toBe(true);
  });

  it("labels the inference in plain language, not as an OEM position", () => {
    const result = assessE20(
      inputOf({ vehicle: vehicle({ emissionNorm: "bs4", manufactureYear: 2018 }) }),
    );
    expect(result.reasons.join(" ")).toContain("inferred from its BS-IV");
    expect(result.oemStatementSummary).toBeNull();
  });

  it("does not fire when a row exists", () => {
    const result = assessE20(
      inputOf({
        vehicle: vehicle({ emissionNorm: "bs3" }),
        compatibility: [compat({ verdict: "e20_compliant" })],
      }),
    );
    expect(result.verdict).toBe("e20_compliant");
    expect(result.inferredFromNorm).toBe(false);
  });

  it("carries medium confidence for BS-VI phase 2 and low for the rest", () => {
    const p2 = assessE20(
      inputOf({ vehicle: vehicle({ emissionNorm: "bs6_phase2" }) }),
    );
    const p1 = assessE20(
      inputOf({ vehicle: vehicle({ emissionNorm: "bs6_phase1" }) }),
    );
    expect(p2.confidence).toBe("medium");
    expect(p1.confidence).toBe("low");
  });
});

describe("unknown is a real answer, not a fallback guess (FR-B5)", () => {
  it("returns unknown when there is neither a row nor a norm", () => {
    const result = assessE20(
      inputOf({ vehicle: vehicle({ emissionNorm: null }) }),
    );
    expect(result.verdict).toBe("unknown");
    expect(result.basis).toBe("no_data");
    expect(result.mileageDelta).toBeNull();
    expect(result.reasons.join(" ")).toContain("no basis for a verdict");
  });

  it("does not invent a risk level or guidance for an unknown verdict", () => {
    const result = assessE20(
      inputOf({
        vehicle: vehicle({ emissionNorm: null }),
        guidanceRules: [guidance({ appliesToVerdict: "e10_only" })],
      }),
    );
    expect(result.materialRiskLevel).toBe("none");
    expect(result.guidance).toEqual([]);
    expect(result.serviceIntervalAdjustment).toBeNull();
  });
});

describe("mileage delta is always a band (FR-B6)", () => {
  it("uses the row's measured figures when it has both bounds", () => {
    const result = assessE20(
      inputOf({
        compatibility: [
          compat({ mileageDeltaMinPct: 2.5, mileageDeltaMaxPct: 4.5 }),
        ],
      }),
    );
    expect(result.mileageDelta).toEqual({ minPct: 2.5, maxPct: 4.5 });
    expect(result.assumptions.join(" ")).not.toContain("band typical of");
  });

  it("falls back to the verdict band when the row has only one bound", () => {
    const result = assessE20(
      inputOf({
        compatibility: [
          compat({
            verdict: "e20_tolerant",
            mileageDeltaMinPct: 2,
            mileageDeltaMaxPct: null,
          }),
        ],
      }),
    );
    expect(result.mileageDelta).toEqual(E20_RULES.mileageDeltaByVerdict.e20_tolerant);
    expect(result.assumptions.join(" ")).toContain("band typical of");
  });

  it("never emits a zero-width band for a petrol verdict", () => {
    for (const verdict of ["e20_compliant", "e20_tolerant", "e10_only"] as const) {
      const band = E20_RULES.mileageDeltaByVerdict[verdict];
      expect(band).not.toBeNull();
      expect(band!.maxPct).toBeGreaterThan(band!.minPct);
    }
  });

  it("orders the bands so a worse verdict never loses less economy", () => {
    const compliant = E20_RULES.mileageDeltaByVerdict.e20_compliant!;
    const tolerant = E20_RULES.mileageDeltaByVerdict.e20_tolerant!;
    const e10 = E20_RULES.mileageDeltaByVerdict.e10_only!;
    expect(tolerant.minPct).toBeGreaterThanOrEqual(compliant.minPct);
    expect(e10.minPct).toBeGreaterThanOrEqual(tolerant.minPct);
    expect(e10.maxPct).toBeGreaterThanOrEqual(tolerant.maxPct);
  });
});

describe("age escalation", () => {
  it("raises risk one level on an old vehicle that already carries some", () => {
    const result = assessE20(
      inputOf({
        vehicle: vehicle({ emissionNorm: "bs4", manufactureYear: 2010 }),
        asOfYear: 2026,
      }),
    );
    expect(result.baseRiskLevel).toBe("moderate");
    expect(result.materialRiskLevel).toBe("high");
    expect(result.riskEscalatedByAge).toBe(true);
  });

  it("never escalates a none base, which would contradict an OEM position", () => {
    const result = assessE20(
      inputOf({
        vehicle: vehicle({ manufactureYear: 2005 }),
        compatibility: [
          compat({ verdict: "e20_compliant", materialRiskLevel: "none" }),
        ],
        asOfYear: 2026,
      }),
    );
    expect(result.materialRiskLevel).toBe("none");
    expect(result.riskEscalatedByAge).toBe(false);
  });

  it("does not escalate below the age threshold", () => {
    const result = assessE20(
      inputOf({
        vehicle: vehicle({ emissionNorm: "bs4", manufactureYear: 2020 }),
        asOfYear: 2026,
      }),
    );
    expect(result.materialRiskLevel).toBe("moderate");
    expect(result.riskEscalatedByAge).toBe(false);
  });

  it("caps at high rather than running off the end of the scale", () => {
    const result = assessE20(
      inputOf({
        vehicle: vehicle({ emissionNorm: "bs3", manufactureYear: 2005 }),
        asOfYear: 2026,
      }),
    );
    expect(result.materialRiskLevel).toBe("high");
  });

  it("reads the year from the input, never from the clock", () => {
    const old = assessE20(
      inputOf({
        vehicle: vehicle({ emissionNorm: "bs4", manufactureYear: 2010 }),
        asOfYear: 2026,
      }),
    );
    const young = assessE20(
      inputOf({
        vehicle: vehicle({ emissionNorm: "bs4", manufactureYear: 2010 }),
        asOfYear: 2020,
      }),
    );
    expect(old.materialRiskLevel).toBe("high");
    expect(young.materialRiskLevel).toBe("moderate");
  });
});

describe("guidance selection is deterministic (FR-B7)", () => {
  const v = vehicle({ emissionNorm: "bs4", manufactureYear: 2018 });

  it("selects only rows matching the verdict", () => {
    const rules = [
      guidance({ id: "match", appliesToVerdict: "e10_only" }),
      guidance({ id: "other", appliesToVerdict: "e20_compliant" }),
    ];
    const picked = selectGuidance(rules, "e10_only", "moderate", v);
    expect(picked.map((r) => r.id)).toEqual(["match"]);
  });

  it("applies the risk floor as a threshold, not an equality", () => {
    const rules = [
      guidance({ id: "any", minRiskLevel: "none" }),
      guidance({ id: "moderate-up", minRiskLevel: "moderate" }),
      guidance({ id: "high-only", minRiskLevel: "high" }),
    ];
    const picked = selectGuidance(rules, "e10_only", "moderate", v);
    expect(picked.map((r) => r.id).sort()).toEqual(["any", "moderate-up"]);
  });

  it("treats an empty body-type list as every body type", () => {
    const rules = [
      guidance({ id: "all", appliesToBodyTypes: [] }),
      guidance({ id: "scooters", appliesToBodyTypes: ["scooter"] }),
      guidance({ id: "hatches", appliesToBodyTypes: ["hatchback", "sedan"] }),
    ];
    const picked = selectGuidance(rules, "e10_only", "moderate", v);
    expect(picked.map((r) => r.id).sort()).toEqual(["all", "hatches"]);
  });

  it("drops a rule whose year ceiling the vehicle has passed", () => {
    const rules = [
      guidance({ id: "pre-2010", appliesToMaxYear: 2010 }),
      guidance({ id: "pre-2020", appliesToMaxYear: 2020 }),
    ];
    const picked = selectGuidance(rules, "e10_only", "moderate", v);
    expect(picked.map((r) => r.id)).toEqual(["pre-2020"]);
  });

  it("sorts by priority, then title, regardless of input order", () => {
    const rules = [
      guidance({ id: "c", priority: 20, title: "Zebra" }),
      guidance({ id: "a", priority: 10, title: "Beta" }),
      guidance({ id: "b", priority: 10, title: "Alpha" }),
    ];
    const forward = selectGuidance(rules, "e10_only", "moderate", v);
    const reversed = selectGuidance([...rules].reverse(), "e10_only", "moderate", v);
    expect(forward.map((r) => r.id)).toEqual(["b", "a", "c"]);
    expect(reversed.map((r) => r.id)).toEqual(forward.map((r) => r.id));
  });

  it("selects against the escalated risk, not the base risk", () => {
    const highOnly = guidance({ id: "high-only", minRiskLevel: "high" });
    const result = assessE20(
      inputOf({
        vehicle: vehicle({ emissionNorm: "bs4", manufactureYear: 2010 }),
        guidanceRules: [highOnly],
        asOfYear: 2026,
      }),
    );
    expect(result.baseRiskLevel).toBe("moderate");
    expect(result.guidance.map((r) => r.id)).toEqual(["high-only"]);
  });

  it("splits the inspection checklist out of the full guidance list", () => {
    const rules = [
      guidance({ id: "insp", kind: "inspection", priority: 10 }),
      guidance({ id: "svc", kind: "service_interval", priority: 20 }),
      guidance({ id: "habit", kind: "driving_habit", priority: 30 }),
    ];
    const result = assessE20(
      inputOf({
        vehicle: vehicle({ emissionNorm: "bs4", manufactureYear: 2018 }),
        guidanceRules: rules,
      }),
    );
    expect(result.guidance.map((r) => r.id)).toEqual(["insp", "svc", "habit"]);
    expect(result.inspectionChecklist.map((r) => r.id)).toEqual(["insp"]);
  });
});

describe("provenance (FR-B8, FR-B9)", () => {
  it("collects source ids from the compatibility row and every guidance row", () => {
    const result = assessE20(
      inputOf({
        vehicle: vehicle({ emissionNorm: "bs4", manufactureYear: 2018 }),
        compatibility: [compat({ verdict: "e10_only", sourceId: "src-compat" })],
        guidanceRules: [
          guidance({ id: "a", sourceId: "src-a" }),
          guidance({ id: "b", sourceId: "src-b", title: "Second" }),
        ],
      }),
    );
    expect(result.sourceIds).toEqual(["src-a", "src-b", "src-compat"]);
  });

  it("deduplicates a source cited by more than one row", () => {
    const result = assessE20(
      inputOf({
        vehicle: vehicle({ emissionNorm: "bs4", manufactureYear: 2018 }),
        compatibility: [compat({ verdict: "e10_only", sourceId: "shared" })],
        guidanceRules: [
          guidance({ id: "a", sourceId: "shared" }),
          guidance({ id: "b", sourceId: "shared", title: "Second" }),
        ],
      }),
    );
    expect(result.sourceIds).toEqual(["shared"]);
  });

  it("carries the OEM statement through verbatim so prose cannot contradict it", () => {
    const summary = "Maruti Suzuki confirms all BS-VI phase 2 petrol engines accept E20.";
    const result = assessE20(
      inputOf({
        compatibility: [
          compat({
            oemStatementSummary: summary,
            oemStatementUrl: "https://example.invalid/e20",
          }),
        ],
      }),
    );
    expect(result.oemStatementSummary).toBe(summary);
    expect(result.oemStatementUrl).toBe("https://example.invalid/e20");
  });

  it("emits no source ids when nothing was sourced", () => {
    const result = assessE20(
      inputOf({ vehicle: vehicle({ emissionNorm: null }) }),
    );
    expect(result.sourceIds).toEqual([]);
  });
});

describe("service interval adjustment", () => {
  it("recommends no change at none risk", () => {
    const result = assessE20(inputOf({ compatibility: [compat()] }));
    expect(result.materialRiskLevel).toBe("none");
    expect(result.serviceIntervalAdjustment).toBeNull();
  });

  it("scales the shortening with the escalated risk level", () => {
    const result = assessE20(
      inputOf({
        vehicle: vehicle({ emissionNorm: "bs4", manufactureYear: 2010 }),
        asOfYear: 2026,
      }),
    );
    expect(result.serviceIntervalAdjustment?.shortenByPct).toBe(
      E20_RULES.serviceIntervalShorteningByRisk.high,
    );
  });

  it("never recommends shortening by more than a quarter", () => {
    for (const pct of Object.values(E20_RULES.serviceIntervalShorteningByRisk)) {
      expect(pct).toBeLessThanOrEqual(25);
    }
  });

  it("orders the shortening monotonically with risk", () => {
    const byRisk = RISK_LEVELS.map(
      (level) => E20_RULES.serviceIntervalShorteningByRisk[level],
    );
    expect([...byRisk].sort((a, b) => a - b)).toEqual(byRisk);
  });
});

describe("assumptions", () => {
  it("notes a missing odometer reading", () => {
    const result = assessE20(
      inputOf({ vehicle: vehicle({ odometerKm: null }) }),
    );
    expect(result.assumptions.join(" ")).toContain("No odometer reading");
  });

  it("stays quiet when the odometer is known", () => {
    const result = assessE20(inputOf());
    expect(result.assumptions.join(" ")).not.toContain("No odometer reading");
  });
});

describe("the rules tables are total", () => {
  it("maps every emission norm to a verdict, a risk and a confidence", () => {
    for (const norm of EMISSION_NORMS) {
      expect(E20_RULES.verdictByNorm[norm]).toBeDefined();
      expect(E20_RULES.riskByNorm[norm]).toBeDefined();
      expect(E20_RULES.confidenceByNorm[norm]).toBeDefined();
    }
  });

  it("maps every verdict to a mileage band or an explicit null", () => {
    for (const verdict of E20_VERDICTS) {
      expect(E20_RULES.mileageDeltaByVerdict).toHaveProperty(verdict);
    }
  });

  it("maps every risk level to a service interval adjustment", () => {
    for (const level of RISK_LEVELS) {
      expect(E20_RULES.serviceIntervalShorteningByRisk[level]).toBeDefined();
    }
  });

  it("compares risk levels by severity, not alphabetically", () => {
    expect(meetsRiskFloor("high", "moderate")).toBe(true);
    expect(meetsRiskFloor("moderate", "high")).toBe(false);
    expect(meetsRiskFloor("low", "low")).toBe(true);
    // "high" < "low" < "moderate" < "none" alphabetically — the wrong order.
    expect(meetsRiskFloor("none", "low")).toBe(false);
  });
});

describe("determinism", () => {
  it("returns the same assessment for the same input", () => {
    const input = inputOf({
      vehicle: vehicle({ emissionNorm: "bs4", manufactureYear: 2012 }),
      compatibility: [
        compat({ id: "a", verdict: "e10_only", materialRiskLevel: "moderate" }),
        compat({ id: "b", verdict: "e20_tolerant", confidence: "low" }),
      ],
      guidanceRules: [
        guidance({ id: "g1", priority: 20 }),
        guidance({ id: "g2", priority: 10, title: "Check the tank" }),
      ],
      asOfYear: 2026,
    });
    expect(assessE20(input)).toEqual(assessE20(input));
  });

  it("does not depend on the order rows arrive in", () => {
    const rows = [
      compat({ id: "a", verdict: "e10_only", confidence: "low" }),
      compat({ id: "b", verdict: "e20_tolerant", confidence: "high" }),
    ];
    const rules = [
      guidance({ id: "g1", appliesToVerdict: "e20_tolerant", priority: 20 }),
      guidance({
        id: "g2",
        appliesToVerdict: "e20_tolerant",
        priority: 10,
        title: "Check the tank",
      }),
    ];
    const forward = assessE20(
      inputOf({ compatibility: rows, guidanceRules: rules }),
    );
    const reversed = assessE20(
      inputOf({
        compatibility: [...rows].reverse(),
        guidanceRules: [...rules].reverse(),
      }),
    );
    expect(forward).toEqual(reversed);
  });
});
