import { describe, expect, it } from "vitest";

import {
  computeOnRoadPrice,
  selectOnRoadFactors,
  type OnRoadFactors,
} from "./on-road";

/** ₹1 lakh = 1e5 rupees = 1e7 paise. */
const lakhs = (n: number) => Math.round(n * 10_000_000);

const factors = (over: Partial<OnRoadFactors> = {}): OnRoadFactors => ({
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
  ...over,
});

describe("selectOnRoadFactors", () => {
  const query = {
    stateCode: "MH",
    category: "passenger" as const,
    fuelType: "electric" as const,
    exShowroomPaise: lakhs(15),
    asOf: "2026-08-23",
  };

  it("prefers a fuel-specific row over the state-wide default", () => {
    const fallback = factors({ roadTaxPct: 11 });
    const evCarveOut = factors({ fuelType: "electric", roadTaxPct: 0 });

    expect(selectOnRoadFactors([fallback, evCarveOut], query)).toBe(evCarveOut);
    // Order in the input must not matter.
    expect(selectOnRoadFactors([evCarveOut, fallback], query)).toBe(evCarveOut);
  });

  it("takes the most recently effective row among equals", () => {
    const older = factors({ effectiveFrom: "2025-04-01", roadTaxPct: 9 });
    const newer = factors({ effectiveFrom: "2026-04-01", roadTaxPct: 11 });

    expect(selectOnRoadFactors([newer, older], query)).toBe(newer);
  });

  it("ignores a rate that has not taken effect yet", () => {
    const current = factors({ effectiveFrom: "2026-01-01" });
    const announced = factors({ effectiveFrom: "2027-04-01" });

    expect(selectOnRoadFactors([current, announced], query)).toBe(current);
  });

  it("treats the price band as min-inclusive and max-exclusive", () => {
    const lower = factors({ priceBandMinPaise: 0, priceBandMaxPaise: lakhs(10) });
    const upper = factors({
      priceBandMinPaise: lakhs(10),
      priceBandMaxPaise: null,
      roadTaxPct: 13,
    });
    const rows = [lower, upper];
    const at = (exShowroomPaise: number) =>
      selectOnRoadFactors(rows, { ...query, exShowroomPaise });

    expect(at(lakhs(10) - 1)).toBe(lower);
    expect(at(lakhs(10))).toBe(upper);
  });

  it("returns null rather than a default when nothing applies", () => {
    expect(selectOnRoadFactors([factors({ stateCode: "KA" })], query)).toBeNull();
    expect(selectOnRoadFactors([], query)).toBeNull();
  });

  it("does not match a row for the other vehicle category", () => {
    const commercial = factors({ category: "commercial" });
    expect(selectOnRoadFactors([commercial], query)).toBeNull();
  });
});

describe("computeOnRoadPrice", () => {
  it("adds road tax, registration, insurance and levies to ex-showroom", () => {
    const price = computeOnRoadPrice(lakhs(10), factors());

    expect(price.roadTaxPaise).toBe(11_000_000);
    expect(price.insurancePaise).toBe(3_000_000);
    expect(price.registrationFeePaise).toBe(60_000);
    expect(price.onRoadPaise).toBe(100_000_000 + 11_000_000 + 60_000 + 3_000_000);
  });

  it("stays in whole paise — no float drift to compound in stage 2", () => {
    const price = computeOnRoadPrice(999_999_999, factors({ roadTaxPct: 12.5 }));

    expect(Number.isInteger(price.roadTaxPaise)).toBe(true);
    expect(Number.isInteger(price.onRoadPaise)).toBe(true);
  });

  it("applies a subsidy as a negative levy", () => {
    const subsidised = computeOnRoadPrice(
      lakhs(15),
      factors({ fuelType: "electric", roadTaxPct: 0, otherLevyPaise: -lakhs(1) }),
    );

    expect(subsidised.otherLevyPaise).toBe(-lakhs(1));
    expect(subsidised.onRoadPaise).toBeLessThan(lakhs(15));
  });

  it("floors at zero when a subsidy would exceed the price", () => {
    const price = computeOnRoadPrice(
      lakhs(1),
      factors({ otherLevyPaise: -lakhs(5) }),
    );

    expect(price.onRoadPaise).toBe(0);
  });

  it("carries the row it used, so the breakdown can be attributed", () => {
    const row = factors();
    expect(computeOnRoadPrice(lakhs(10), row).factors).toBe(row);
  });
});
