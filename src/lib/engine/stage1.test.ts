import { describe, expect, it } from "vitest";

import type { CandidateVariant, InfraSnapshot } from "./candidate";
import type { OnRoadFactors } from "./on-road";
import { parseProfile, type RecommendationProfileInput } from "./profile";
import {
  applyFeasibilityGates,
  applyHardFilters,
  runStage1,
  type Stage1Input,
} from "./stage1";

/** ₹1 lakh = 1e5 rupees = 1e7 paise. */
const lakhs = (n: number) => Math.round(n * 10_000_000);

const MH_DEFAULT: OnRoadFactors = {
  stateCode: "MH",
  category: "passenger",
  fuelType: null,
  priceBandMinPaise: 0,
  priceBandMaxPaise: null,
  roadTaxPct: 11,
  registrationFeePaise: 60_000,
  insurancePct: 3,
  otherLevyPaise: 0,
  effectiveFrom: "2026-01-01",
};

const passengerInput: RecommendationProfileInput = {
  category: "passenger",
  location: { stateCode: "MH" },
  budget: { maxOnRoadPaise: lakhs(12) },
  usage: { dailyKm: 40, monthlyKm: 1200, typicalTripKm: 25, citySharePct: 70 },
  charging: { homeCharging: true },
  preferences: {},
  financing: { mode: "cash" },
  ownershipYears: 7,
  passengers: 5,
};

const profileOf = (over: Partial<RecommendationProfileInput> = {}) =>
  parseProfile({ ...passengerInput, ...over } as RecommendationProfileInput);

const variant = (over: Partial<CandidateVariant> = {}): CandidateVariant => ({
  variantId: "v1",
  modelId: "m1",
  name: "Test Hatch VXi",
  category: "passenger",
  bodyType: "hatchback",
  status: "active",
  fuelType: "petrol",
  exShowroomPaise: lakhs(10),
  seatingCapacity: 5,
  payloadKg: null,
  realWorldRangeKm: null,
  availableInState: true,
  ...over,
});

const inputOf = (over: Partial<Stage1Input> = {}): Stage1Input => ({
  profile: profileOf(),
  candidates: [variant()],
  onRoadFactors: [MH_DEFAULT],
  infra: {},
  asOf: "2026-08-23",
  ...over,
});

const codes = (exclusions: { code: string }[]) => exclusions.map((e) => e.code);

describe("hard filters", () => {
  it("keeps an affordable variant and prices it on-road", () => {
    const { candidates, exclusions } = applyHardFilters(inputOf());

    expect(exclusions).toEqual([]);
    expect(candidates).toHaveLength(1);
    // ₹10L ex-showroom + 11% tax + 3% insurance + ₹600 registration.
    expect(candidates[0].price.onRoadPaise).toBe(114_060_000);
  });

  it("judges the budget on on-road price, not ex-showroom (FR-A3)", () => {
    // ₹11L is inside a ₹12L budget on the sticker and outside it on the road.
    const { candidates, exclusions } = applyHardFilters(
      inputOf({ candidates: [variant({ exShowroomPaise: lakhs(11) })] }),
    );

    expect(candidates).toEqual([]);
    expect(codes(exclusions)).toEqual(["above_budget"]);
    expect(exclusions[0].reason).toContain("12.00 lakh");
  });

  it("honours a budget floor when one is set", () => {
    const { exclusions } = applyHardFilters(
      inputOf({
        profile: profileOf({
          budget: { maxOnRoadPaise: lakhs(12), minOnRoadPaise: lakhs(11.5) },
        }),
      }),
    );

    expect(codes(exclusions)).toEqual(["below_budget_floor"]);
  });

  it("excludes rather than prices at ex-showroom when no rate row applies", () => {
    const { candidates, exclusions } = applyHardFilters(
      inputOf({ onRoadFactors: [{ ...MH_DEFAULT, stateCode: "KA" }] }),
    );

    expect(candidates).toEqual([]);
    expect(codes(exclusions)).toEqual(["on_road_price_unknown"]);
  });

  it("excludes below the seating requirement", () => {
    const { exclusions } = applyHardFilters(
      inputOf({
        profile: profileOf({ passengers: 7 }),
        candidates: [variant({ seatingCapacity: 5 })],
      }),
    );

    expect(codes(exclusions)).toEqual(["seating_below_requirement"]);
    expect(exclusions[0].reason).toContain("Seats 5");
  });

  it("excludes when the seat count is unknown — an untestable requirement fails", () => {
    const { exclusions } = applyHardFilters(
      inputOf({ candidates: [variant({ seatingCapacity: null })] }),
    );

    expect(codes(exclusions)).toEqual(["seating_unknown"]);
  });

  it("excludes an unpriced variant", () => {
    const { exclusions } = applyHardFilters(
      inputOf({ candidates: [variant({ exShowroomPaise: null })] }),
    );

    expect(codes(exclusions)).toEqual(["price_unknown"]);
  });

  it("excludes a variant the state does not sell, quoting the note", () => {
    const { exclusions } = applyHardFilters(
      inputOf({
        candidates: [
          variant({
            availableInState: false,
            availabilityNote: "Withdrawn from Maharashtra pending certification.",
          }),
        ],
      }),
    );

    expect(codes(exclusions)).toEqual(["unavailable_in_state"]);
    expect(exclusions[0].reason).toBe(
      "Withdrawn from Maharashtra pending certification.",
    );
  });

  it("excludes a fuel the user ruled out, and says so", () => {
    const { exclusions } = applyHardFilters(
      inputOf({
        profile: profileOf({ preferences: { excludedFuelTypes: ["diesel"] } }),
        candidates: [variant({ fuelType: "diesel" })],
      }),
    );

    expect(codes(exclusions)).toEqual(["fuel_excluded_by_user"]);
    expect(exclusions[0].reason).toContain("ruled out");
  });

  it("never shows a passenger buyer a commercial body type", () => {
    const { exclusions } = applyHardFilters(
      inputOf({ candidates: [variant({ bodyType: "tipper" })] }),
    );

    expect(codes(exclusions)).toEqual(["body_type_wrong_category"]);
  });

  it("drops variants that are not on sale", () => {
    const { exclusions } = applyHardFilters(
      inputOf({
        candidates: [
          variant({ variantId: "a", status: "discontinued" }),
          variant({ variantId: "b", status: "upcoming" }),
        ],
      }),
    );

    expect(codes(exclusions)).toEqual(["not_active", "not_active"]);
  });

  it("reports one reason per variant, most fundamental first", () => {
    // Wrong category *and* over budget *and* under-seated.
    const { exclusions } = applyHardFilters(
      inputOf({
        candidates: [
          variant({
            category: "commercial",
            bodyType: "lcv",
            exShowroomPaise: lakhs(30),
            seatingCapacity: 2,
          }),
        ],
      }),
    );

    expect(codes(exclusions)).toEqual(["wrong_category"]);
  });
});

describe("hard filters, commercial profiles", () => {
  const commercialInput: RecommendationProfileInput = {
    category: "commercial",
    location: { stateCode: "MH" },
    budget: { maxOnRoadPaise: lakhs(12) },
    usage: { dailyKm: 120, monthlyKm: 3000, typicalTripKm: 60, citySharePct: 80 },
    charging: { homeCharging: false },
    preferences: {},
    financing: { mode: "cash" },
    ownershipYears: 6,
    payloadKg: 1000,
    revenuePaisePerKm: 2500,
    driverCostPaisePerMonth: 0,
  };

  const commercialFactors: OnRoadFactors = {
    ...MH_DEFAULT,
    category: "commercial",
  };

  const truck = (over: Partial<CandidateVariant> = {}) =>
    variant({
      category: "commercial",
      bodyType: "mini_truck",
      seatingCapacity: 2,
      payloadKg: 1200,
      ...over,
    });

  it("keeps a truck that carries the stated load", () => {
    const { candidates, exclusions } = applyHardFilters(
      inputOf({
        profile: parseProfile(commercialInput),
        candidates: [truck()],
        onRoadFactors: [commercialFactors],
      }),
    );

    expect(exclusions).toEqual([]);
    expect(candidates).toHaveLength(1);
  });

  it("excludes below the payload requirement", () => {
    const { exclusions } = applyHardFilters(
      inputOf({
        profile: parseProfile(commercialInput),
        candidates: [truck({ payloadKg: 750 })],
        onRoadFactors: [commercialFactors],
      }),
    );

    expect(codes(exclusions)).toEqual(["payload_below_requirement"]);
    expect(exclusions[0].reason).toContain("750 kg");
  });

  it("excludes when payload is unpublished", () => {
    const { exclusions } = applyHardFilters(
      inputOf({
        profile: parseProfile(commercialInput),
        candidates: [truck({ payloadKg: null })],
        onRoadFactors: [commercialFactors],
      }),
    );

    expect(codes(exclusions)).toEqual(["payload_unknown"]);
  });

  it("does not apply the seating filter to a commercial profile", () => {
    const { candidates } = applyHardFilters(
      inputOf({
        profile: parseProfile(commercialInput),
        candidates: [truck({ seatingCapacity: null })],
        onRoadFactors: [commercialFactors],
      }),
    );

    expect(candidates).toHaveLength(1);
  });
});

describe("fuel feasibility gates", () => {
  const priced = (v: CandidateVariant) => {
    const { candidates } = applyHardFilters(inputOf({ candidates: [v] }));
    expect(candidates).toHaveLength(1);
    return candidates;
  };

  const infraOf = (over: InfraSnapshot): InfraSnapshot => over;

  describe("CNG", () => {
    const cng = variant({ fuelType: "cng" });

    it("excludes CNG where the network is bottom-decile", () => {
      const { candidates, exclusions } = applyFeasibilityGates(
        priced(cng),
        profileOf(),
        infraOf({
          cng: { type: "cng", stationCount: 3, percentile: 7, confidenceScore: 80 },
        }),
      );

      expect(candidates).toEqual([]);
      expect(codes(exclusions)).toEqual(["refuelling_network_absent"]);
      expect(exclusions[0].stage).toBe("feasibility_gate");
    });

    it("excludes CNG where there are no stations at all", () => {
      const { exclusions } = applyFeasibilityGates(
        priced(cng),
        profileOf(),
        infraOf({
          cng: { type: "cng", stationCount: 0, percentile: null, confidenceScore: 90 },
        }),
      );

      expect(exclusions[0].reason).toContain("No CNG stations");
    });

    it("keeps CNG where the network is ordinary", () => {
      const { candidates, exclusions } = applyFeasibilityGates(
        priced(cng),
        profileOf(),
        infraOf({
          cng: { type: "cng", stationCount: 120, percentile: 65, confidenceScore: 80 },
        }),
      );

      expect(candidates).toHaveLength(1);
      expect(exclusions).toEqual([]);
    });

    it("keeps CNG when there is no data, and records the assumption", () => {
      const { candidates, exclusions, assumptions } = applyFeasibilityGates(
        priced(cng),
        profileOf(),
        {},
      );

      expect(candidates).toHaveLength(1);
      expect(exclusions).toEqual([]);
      expect(assumptions).toHaveLength(1);
      expect(assumptions[0]).toContain("not tested");
    });

    it("does not gate petrol on missing station data", () => {
      const { candidates, assumptions } = applyFeasibilityGates(
        priced(variant()),
        profileOf(),
        {},
      );

      expect(candidates).toHaveLength(1);
      expect(assumptions).toEqual([]);
    });
  });

  describe("electric", () => {
    const ev = (over: Partial<CandidateVariant> = {}) =>
      variant({ fuelType: "electric", realWorldRangeKm: 250, ...over });

    const goodDc = infraOf({
      ev_dc: { type: "ev_dc", stationCount: 90, percentile: 70, confidenceScore: 75 },
    });

    const noHomeCharging = (dailyKm: number) =>
      profileOf({
        charging: { homeCharging: false },
        usage: { dailyKm, monthlyKm: 6000, typicalTripKm: 30, citySharePct: 70 },
      });

    it("excludes an EV whose range cannot cover the day without home charging", () => {
      const { candidates, exclusions } = applyFeasibilityGates(
        priced(ev()),
        noHomeCharging(220), // > 0.8 x 250 km
        goodDc,
      );

      expect(candidates).toEqual([]);
      expect(codes(exclusions)).toEqual(["ev_range_short_no_home_charging"]);
      expect(exclusions[0].reason).toContain("200 km");
    });

    it("keeps the same EV once home charging is available", () => {
      const { candidates } = applyFeasibilityGates(
        priced(ev()),
        profileOf({
          usage: {
            dailyKm: 220,
            monthlyKm: 6000,
            typicalTripKm: 30,
            citySharePct: 70,
          },
        }),
        goodDc,
      );

      expect(candidates).toHaveLength(1);
    });

    it("uses the longer of daily distance and typical trip", () => {
      const longTrip = profileOf({
        charging: { homeCharging: false },
        usage: {
          dailyKm: 30,
          monthlyKm: 900,
          typicalTripKm: 240,
          citySharePct: 40,
        },
      });

      const { exclusions } = applyFeasibilityGates(priced(ev()), longTrip, goodDc);
      expect(codes(exclusions)).toEqual(["ev_range_short_no_home_charging"]);
    });

    it("excludes an EV where public DC is sparse and there is no home charging", () => {
      const { exclusions } = applyFeasibilityGates(
        priced(ev()),
        noHomeCharging(40),
        infraOf({
          ev_dc: { type: "ev_dc", stationCount: 2, percentile: 4, confidenceScore: 80 },
        }),
      );

      expect(codes(exclusions)).toEqual(["ev_thin_dc_network_no_home_charging"]);
    });

    it("excludes an EV where the DC evidence is too thin to rely on", () => {
      const { exclusions } = applyFeasibilityGates(
        priced(ev()),
        noHomeCharging(40),
        infraOf({
          ev_dc: {
            type: "ev_dc",
            stationCount: 40,
            percentile: 60,
            confidenceScore: 20,
          },
        }),
      );

      expect(codes(exclusions)).toEqual(["ev_thin_dc_network_no_home_charging"]);
    });

    it("keeps an EV with adequate range and a real DC network", () => {
      const { candidates, exclusions, assumptions } = applyFeasibilityGates(
        priced(ev()),
        noHomeCharging(40),
        goodDc,
      );

      expect(candidates).toHaveLength(1);
      expect(exclusions).toEqual([]);
      expect(assumptions).toEqual([]);
    });

    it("records an assumption rather than excluding when range is unpublished", () => {
      const { candidates, assumptions } = applyFeasibilityGates(
        priced(ev({ realWorldRangeKm: null })),
        noHomeCharging(400),
        goodDc,
      );

      expect(candidates).toHaveLength(1);
      expect(assumptions[0]).toContain("Real-world range");
    });

    it("records an assumption when there is no charging data at all", () => {
      const { candidates, assumptions } = applyFeasibilityGates(
        priced(ev()),
        noHomeCharging(40),
        {},
      );

      expect(candidates).toHaveLength(1);
      expect(assumptions).toEqual([
        "No public DC charging data for this location; electric vehicles were not tested for charging access.",
      ]);
    });

    it("never range-gates a plug-in hybrid — it still burns petrol", () => {
      const { candidates, exclusions } = applyFeasibilityGates(
        priced(ev({ fuelType: "plugin_hybrid", realWorldRangeKm: 40 })),
        noHomeCharging(300),
        {},
      );

      expect(candidates).toHaveLength(1);
      expect(exclusions).toEqual([]);
    });
  });
});

describe("runStage1", () => {
  it("applies filters before gates, so the reported reason is the first one that bites", () => {
    // An EV that is both over budget and unusable without home charging.
    const result = runStage1(
      inputOf({
        profile: profileOf({
          charging: { homeCharging: false },
          usage: {
            dailyKm: 300,
            monthlyKm: 8000,
            typicalTripKm: 300,
            citySharePct: 50,
          },
        }),
        candidates: [
          variant({
            fuelType: "electric",
            exShowroomPaise: lakhs(30),
            realWorldRangeKm: 200,
          }),
        ],
        infra: {},
      }),
    );

    expect(result.candidates).toEqual([]);
    expect(codes(result.exclusions)).toEqual(["above_budget"]);
    // The gate never ran, so it recorded nothing about missing charger data.
    expect(result.assumptions).toEqual([]);
  });

  it("returns survivors and every exclusion, from both stages", () => {
    const result = runStage1(
      inputOf({
        candidates: [
          variant({ variantId: "keep", name: "Keeper" }),
          variant({ variantId: "pricey", exShowroomPaise: lakhs(20) }),
          variant({
            variantId: "cng",
            fuelType: "cng",
            name: "CNG variant",
          }),
        ],
        infra: {
          cng: { type: "cng", stationCount: 0, percentile: 0, confidenceScore: 60 },
        },
      }),
    );

    expect(result.candidates.map((c) => c.variant.variantId)).toEqual(["keep"]);
    expect(result.exclusions.map((e) => e.variantId)).toEqual(["pricey", "cng"]);
    expect(result.exclusions.map((e) => e.stage)).toEqual([
      "hard_filter",
      "feasibility_gate",
    ]);
  });

  it("returns an empty candidate set with reasons, never a bare empty result", () => {
    const result = runStage1(
      inputOf({ candidates: [variant({ exShowroomPaise: lakhs(50) })] }),
    );

    expect(result.candidates).toEqual([]);
    expect(result.exclusions).toHaveLength(1);
    expect(result.exclusions[0].reason).not.toBe("");
  });
});
