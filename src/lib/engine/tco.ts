import type { FuelType, VehicleCategory } from "./enums";
import type { OnRoadPrice } from "./on-road";
import { type RecommendationProfile } from "./profile";

/**
 * Stage 2 — total cost of ownership (FR-A6).
 *
 * Acquisition, energy, maintenance, insurance renewals, financing interest and
 * probability-weighted battery replacement, less the resale residual. All
 * arithmetic in whole paise: a ₹50L price is 5e9 paise, past int32, and float
 * rupees drift once compounded across a ten-year horizon.
 *
 * Every figure derives from `realWorldEfficiency*` and `realWorldRangeKm`
 * (FR-A7). The ARAI claims are not on `VariantEconomics` at all, so there is no
 * path by which they could be.
 *
 * A variant that cannot be costed is returned as a failure with a reason, not
 * costed on a guess. Same doctrine as stage 1: a wrong number is worse than a
 * missing one, because a wrong number ranks.
 */

/** Modelling conventions that are ours, not sourced. Exported so the
 * explainability payload can state them rather than bury them. */
export const TCO_CONVENTIONS = {
  /**
   * Years over which the chance that the *owner* pays for a battery
   * replacement tapers to zero as the crossing point approaches the end of the
   * hold. An owner whose battery hits the replacement threshold two months
   * before they sell does not replace it; they sell.
   */
  batteryReplacementTaperYears: 2,
  /**
   * Energy and maintenance prices are held flat across the horizon. We hold no
   * sourced escalation curve, and inventing one would move every candidate in
   * the same direction anyway, changing the totals without changing the order.
   */
  priceEscalationPct: 0,
} as const;

/**
 * The variant fields the economics need. Separate from `CandidateVariant`
 * because stage 1 has no use for them, and because keeping the type minimal is
 * what makes the FR-A7 guarantee structural rather than a matter of care.
 */
export interface VariantEconomics {
  variantId: string;
  fuelType: FuelType;
  category: VehicleCategory;
  /** Maintenance and resale curves are keyed by segment, not by variant:
   * per-variant service pricing is not published widely enough to be reliable. */
  segment: string;
  exShowroomPaise: number;
  realWorldEfficiencyCity: number | null;
  realWorldEfficiencyHighway: number | null;
  /** `kmpl`, `km/kg` or `km/kWh`. Decides which price applies, so a plug-in
   * hybrid is costed on whichever leg the catalogue actually characterises. */
  efficiencyUnit: string | null;
  batteryKwh: number | null;
  batteryChemistry: string | null;
  batteryWarrantyYears: number | null;
  batteryWarrantyKm: number | null;
  /** Manufacturer service package, where published. Overrides the segment
   * curve for the years it covers. */
  scheduledServiceCost5yPaise: number | null;
}

export interface EnergyPrice {
  /** Paise per litre, per kg or per kWh, per `unit`. */
  pricePaise: number;
  unit: string;
  asOf: string;
}

export interface MaintenanceCurvePoint {
  segment: string;
  fuelType: FuelType;
  category: VehicleCategory;
  ownershipYear: number;
  costPaise: number;
  referenceAnnualKm: number;
  marginalCostPaisePerKm: number;
}

export interface ResaleCurvePoint {
  segment: string;
  fuelType: FuelType;
  category: VehicleCategory;
  ageYears: number;
  residualPct: number;
}

export interface BatteryCost {
  chemistry: string;
  pricePaisePerKwh: number;
  annualDegradationPct: number;
  replacementThresholdPct: number;
}

export interface FinanceRate {
  category: VehicleCategory;
  fuelType: FuelType | null;
  annualRatePct: number;
  processingFeePct: number;
}

export interface EconomicsTables {
  /** Keyed by fuel type. `electric` carries paise per kWh at the tariff the
   * household actually pays — slab selection needs a household base load the
   * profile does not carry, so it is resolved in the query layer. */
  energyPrices: Partial<Record<FuelType, EnergyPrice>>;
  maintenance: readonly MaintenanceCurvePoint[];
  resale: readonly ResaleCurvePoint[];
  batteries: readonly BatteryCost[];
  financeRates: readonly FinanceRate[];
  /**
   * Applied to the resale credit only. Resale is the one large flow that lands
   * entirely at the far end of the horizon, so counting it at face value would
   * overstate how much it offsets. Running costs accrue evenly and are quoted
   * nominally, because that is the number a buyer plans against.
   */
  discountRatePct: number;
}

export interface YearlyCost {
  /** 1-indexed year of ownership. */
  year: number;
  energyPaise: number;
  maintenancePaise: number;
  insurancePaise: number;
  interestPaise: number;
  batteryPaise: number;
  totalPaise: number;
}

export interface TcoBreakdown {
  variantId: string;
  ownershipYears: number;
  totalKm: number;
  /** On-road price plus any loan processing fee. */
  acquisitionPaise: number;
  energyPaise: number;
  maintenancePaise: number;
  insuranceRenewalPaise: number;
  financingInterestPaise: number;
  batteryReplacementPaise: number;
  /** Face value of the vehicle at the end of the horizon. */
  resaleNominalPaise: number;
  /** What that residual is worth today, and what `totalPaise` nets off. */
  resaleCreditPaise: number;
  totalPaise: number;
  costPaisePerKm: number;
  yearly: YearlyCost[];
  assumptions: string[];
}

export type TcoFailureCode =
  | "efficiency_missing"
  | "energy_price_missing"
  | "maintenance_curve_missing"
  | "resale_curve_missing"
  | "battery_cost_missing"
  | "finance_rate_missing";

export type TcoResult =
  | { ok: true; tco: TcoBreakdown }
  | { ok: false; variantId: string; code: TcoFailureCode; reason: string };

export interface TcoInput {
  profile: RecommendationProfile;
  /** Carried through from stage 1 rather than recomputed — it is the same
   * number the budget filter judged, and `factors` supplies the insurance rate
   * that renewals are derived from. */
  price: OnRoadPrice;
  variant: VariantEconomics;
  tables: EconomicsTables;
}

const fail = (
  variantId: string,
  code: TcoFailureCode,
  reason: string,
): TcoResult => ({ ok: false, variantId, code, reason });

/**
 * Distance-weighted blend of the city and highway figures.
 *
 * The two differ by 20% or more, which is wider than the gap between many
 * rival variants, so the split matters more than it looks. Where only one is
 * published we use it for the whole distance rather than discarding the
 * variant, and say so.
 */
export function blendedEfficiency(
  variant: VariantEconomics,
  citySharePct: number,
): { value: number; assumption?: string } | null {
  const { realWorldEfficiencyCity: city, realWorldEfficiencyHighway: hw } =
    variant;

  if (city !== null && hw !== null) {
    const share = citySharePct / 100;
    return { value: city * share + hw * (1 - share) };
  }
  if (city !== null) {
    return {
      value: city,
      assumption:
        "No highway efficiency published for every variant; the city figure was used for the whole distance.",
    };
  }
  if (hw !== null) {
    return {
      value: hw,
      assumption:
        "No city efficiency published for every variant; the highway figure was used for the whole distance.",
    };
  }
  return null;
}

/**
 * Interest actually paid inside the ownership horizon.
 *
 * Modelled as cash out rather than as a loan schedule: over the horizon the
 * buyer pays the down payment, the fee and the EMIs, and at the end owes the
 * outstanding principal, which the sale settles. Those net to the full on-road
 * price plus the interest paid so far — so that is what TCO carries, and a
 * tenure running past the horizon does not need special-casing.
 */
export function interestPaidWithinHorizon(
  principalPaise: number,
  annualRatePct: number,
  tenureMonths: number,
  horizonMonths: number,
): number {
  if (principalPaise <= 0 || tenureMonths <= 0) return 0;

  const months = Math.min(tenureMonths, horizonMonths);
  const monthlyRate = annualRatePct / 100 / 12;

  if (monthlyRate === 0) return 0;

  const growth = (1 + monthlyRate) ** tenureMonths;
  const emi = (principalPaise * monthlyRate * growth) / (growth - 1);

  let balance = principalPaise;
  let interest = 0;
  for (let m = 0; m < months; m += 1) {
    const monthInterest = balance * monthlyRate;
    interest += monthInterest;
    balance -= emi - monthInterest;
  }
  return Math.round(interest);
}

/** The applicable finance rate: fuel-specific beats the category default. */
export function selectFinanceRate(
  rates: readonly FinanceRate[],
  category: VehicleCategory,
  fuelType: FuelType,
): FinanceRate | null {
  const applicable = rates.filter(
    (r) =>
      r.category === category &&
      (r.fuelType === null || r.fuelType === fuelType),
  );
  applicable.sort(
    (a, b) => Number(b.fuelType !== null) - Number(a.fuelType !== null),
  );
  return applicable[0] ?? null;
}

/**
 * Residual value as a share of ex-showroom at a given age.
 *
 * Curves are sampled per year, so an exact hit is the normal case. Past the
 * last sampled age the final point is carried forward — extrapolating a
 * depreciation curve invents value at exactly the point where the used market
 * is thinnest.
 */
function residualPctAt(
  curve: readonly ResaleCurvePoint[],
  ageYears: number,
): { pct: number; assumption?: string } | null {
  if (curve.length === 0) return null;

  const exact = curve.find((p) => p.ageYears === ageYears);
  if (exact) return { pct: exact.residualPct };

  const sorted = [...curve].sort((a, b) => a.ageYears - b.ageYears);
  const oldest = sorted[sorted.length - 1];
  if (ageYears > oldest.ageYears) {
    return {
      pct: oldest.residualPct,
      assumption: `Resale curves stop at ${oldest.ageYears} years; the ${oldest.ageYears}-year residual was held flat beyond that.`,
    };
  }

  const below = sorted.filter((p) => p.ageYears < ageYears).pop();
  const above = sorted.find((p) => p.ageYears > ageYears);
  if (below === undefined || above === undefined) {
    return { pct: sorted[0].residualPct };
  }
  const span = above.ageYears - below.ageYears;
  const t = (ageYears - below.ageYears) / span;
  return { pct: below.residualPct + (above.residualPct - below.residualPct) * t };
}

/**
 * Probability-weighted battery replacement.
 *
 * Capacity is faded exponentially to find the year the pack crosses the
 * replacement threshold. Inside the warranty the manufacturer pays. Past it,
 * the cost counts in full unless the crossing lands near the end of the hold,
 * where the taper reflects that owners in that position sell rather than
 * replace.
 */
function batteryReplacementCost(
  variant: VariantEconomics,
  cost: BatteryCost,
  ownershipYears: number,
  annualKm: number,
): { paise: number; year: number | null; assumption?: string } {
  const kwh = variant.batteryKwh;
  if (kwh === null || kwh <= 0) return { paise: 0, year: null };

  const fade = cost.annualDegradationPct / 100;
  if (fade <= 0) return { paise: 0, year: null };

  // (1 - fade)^y = threshold  =>  y = ln(threshold) / ln(1 - fade)
  const crossingYear =
    Math.log(cost.replacementThresholdPct / 100) / Math.log(1 - fade);

  if (crossingYear >= ownershipYears) return { paise: 0, year: null };

  const withinWarrantyYears =
    variant.batteryWarrantyYears !== null &&
    crossingYear <= variant.batteryWarrantyYears;
  const withinWarrantyKm =
    variant.batteryWarrantyKm !== null &&
    crossingYear * annualKm <= variant.batteryWarrantyKm;

  if (withinWarrantyYears && withinWarrantyKm) {
    return {
      paise: 0,
      year: null,
      assumption: `The pack is expected to reach its replacement threshold at about year ${crossingYear.toFixed(1)}, inside the battery warranty, so no replacement cost is counted.`,
    };
  }

  const yearsRemaining = ownershipYears - crossingYear;
  const weight = Math.min(
    1,
    yearsRemaining / TCO_CONVENTIONS.batteryReplacementTaperYears,
  );

  return {
    paise: Math.round(kwh * cost.pricePaisePerKwh * weight),
    year: Math.ceil(crossingYear),
    assumption:
      weight < 1
        ? `A replacement falls late in the horizon (about year ${crossingYear.toFixed(1)}); it is weighted at ${Math.round(weight * 100)}% because owners at that point typically sell rather than replace.`
        : undefined,
  };
}

export function computeTco(input: TcoInput): TcoResult {
  const { profile, price, variant, tables } = input;
  const { ownershipYears } = profile;
  const assumptions = new Set<string>();

  // --- distance
  /** Monthly distance is stated directly by the user and is the more reliable
   * aggregate; daily distance drives the range gate, not the totals. */
  const annualKm = profile.usage.monthlyKm * 12;
  const totalKm = annualKm * ownershipYears;

  // --- energy
  const efficiency = blendedEfficiency(variant, profile.usage.citySharePct);
  if (efficiency === null) {
    return fail(
      variant.variantId,
      "efficiency_missing",
      "No real-world efficiency published, so running cost cannot be computed. ARAI figures are not substituted.",
    );
  }
  if (efficiency.assumption) assumptions.add(efficiency.assumption);
  if (efficiency.value <= 0) {
    return fail(
      variant.variantId,
      "efficiency_missing",
      "Published real-world efficiency is not a usable figure.",
    );
  }

  const energyPrice = tables.energyPrices[variant.fuelType];
  if (energyPrice === undefined) {
    return fail(
      variant.variantId,
      "energy_price_missing",
      `No ${variant.fuelType} price on file for this location, so running cost cannot be computed.`,
    );
  }
  const annualEnergyPaise = Math.round(
    (annualKm / efficiency.value) * energyPrice.pricePaise,
  );

  // --- maintenance
  const curve = tables.maintenance.filter(
    (p) =>
      p.segment === variant.segment &&
      p.fuelType === variant.fuelType &&
      p.category === variant.category,
  );
  if (curve.length === 0) {
    return fail(
      variant.variantId,
      "maintenance_curve_missing",
      `No maintenance curve for ${variant.segment} ${variant.fuelType}, so upkeep cannot be costed.`,
    );
  }

  /** Years the published service package covers, where there is one. */
  const packageYears =
    variant.scheduledServiceCost5yPaise !== null
      ? Math.min(5, ownershipYears)
      : 0;
  if (packageYears > 0) {
    assumptions.add(
      `The manufacturer's 5-year service package is spread evenly across its ${packageYears} covered year(s); the segment curve is used beyond it.`,
    );
  }

  const maintenanceForYear = (year: number): number => {
    if (year <= packageYears && variant.scheduledServiceCost5yPaise !== null) {
      return Math.round(variant.scheduledServiceCost5yPaise / 5);
    }
    const exact = curve.find((p) => p.ownershipYear === year);
    const point =
      exact ??
      [...curve]
        .sort((a, b) => a.ownershipYear - b.ownershipYear)
        .filter((p) => p.ownershipYear < year)
        .pop();
    if (point === undefined) return 0;
    if (exact === undefined) {
      assumptions.add(
        `The maintenance curve for ${variant.segment} ${variant.fuelType} stops at year ${point.ownershipYear}; later years were held at that cost.`,
      );
    }
    const excessKm = Math.max(0, annualKm - point.referenceAnnualKm);
    return point.costPaise + Math.round(excessKm * point.marginalCostPaisePerKm);
  };

  // --- resale
  const resaleCurve = tables.resale.filter(
    (p) =>
      p.segment === variant.segment &&
      p.fuelType === variant.fuelType &&
      p.category === variant.category,
  );
  const residualAtExit = residualPctAt(resaleCurve, ownershipYears);
  if (residualAtExit === null) {
    return fail(
      variant.variantId,
      "resale_curve_missing",
      `No resale curve for ${variant.segment} ${variant.fuelType}, so the residual cannot be credited.`,
    );
  }
  if (residualAtExit.assumption) assumptions.add(residualAtExit.assumption);

  // --- insurance renewals
  /**
   * Year 1 is already inside the on-road price. Later years are priced off the
   * same state percentage applied to what the vehicle is then worth, because
   * own-damage premium tracks insured value. It is the only renewal model our
   * tables can support without inventing a premium curve.
   */
  const insuranceForYear = (year: number): number => {
    if (year === 1) return 0;
    const residual = residualPctAt(resaleCurve, year - 1);
    if (residual === null) return 0;
    return Math.round(
      (variant.exShowroomPaise * (residual.pct / 100) * price.factors.insurancePct) /
        100,
    );
  };
  if (ownershipYears > 1) {
    assumptions.add(
      "Insurance renewals after year one are estimated from the state's first-year rate applied to the vehicle's depreciated value.",
    );
  }

  // --- financing
  let processingFeePaise = 0;
  let financingInterestPaise = 0;
  let interestByYear: number[] = new Array(ownershipYears).fill(0);

  if (profile.financing.mode === "loan") {
    const rate = selectFinanceRate(
      tables.financeRates,
      variant.category,
      variant.fuelType,
    );
    const annualRatePct = profile.financing.annualRatePct ?? rate?.annualRatePct;
    if (annualRatePct === undefined) {
      return fail(
        variant.variantId,
        "finance_rate_missing",
        "No lending rate on file for this category and fuel, and none was supplied, so financing cost cannot be computed.",
      );
    }
    if (profile.financing.annualRatePct !== undefined) {
      assumptions.add(
        `Financing is costed at the ${profile.financing.annualRatePct}% rate you supplied rather than the market average.`,
      );
    }

    const principal = Math.round(
      price.onRoadPaise * (1 - profile.financing.downPaymentPct / 100),
    );
    processingFeePaise = Math.round(
      (principal * (rate?.processingFeePct ?? 0)) / 100,
    );

    const { tenureMonths } = profile.financing;
    let cumulative = 0;
    interestByYear = Array.from({ length: ownershipYears }, (_, i) => {
      const toEndOfYear = interestPaidWithinHorizon(
        principal,
        annualRatePct,
        tenureMonths,
        (i + 1) * 12,
      );
      const thisYear = toEndOfYear - cumulative;
      cumulative = toEndOfYear;
      return thisYear;
    });
    financingInterestPaise = cumulative;
  }

  // --- battery replacement
  let batteryReplacementPaise = 0;
  let batteryYear: number | null = null;
  const needsBattery =
    variant.fuelType === "electric" || variant.fuelType === "plugin_hybrid";

  if (needsBattery && variant.batteryKwh !== null) {
    const chemistry = variant.batteryChemistry;
    const cost =
      tables.batteries.find((b) => b.chemistry === chemistry) ?? null;
    if (cost === null) {
      return fail(
        variant.variantId,
        "battery_cost_missing",
        `No replacement cost on file for a ${chemistry ?? "unspecified"} pack, so the largest uncertainty in EV ownership cannot be quantified.`,
      );
    }
    const replacement = batteryReplacementCost(
      variant,
      cost,
      ownershipYears,
      annualKm,
    );
    batteryReplacementPaise = replacement.paise;
    batteryYear = replacement.year;
    if (replacement.assumption) assumptions.add(replacement.assumption);
  }

  // --- assemble
  const yearly: YearlyCost[] = Array.from(
    { length: ownershipYears },
    (_, i) => {
      const year = i + 1;
      const energyPaise = annualEnergyPaise;
      const maintenancePaise = maintenanceForYear(year);
      const insurancePaise = insuranceForYear(year);
      const interestPaise = interestByYear[i] ?? 0;
      const batteryPaise = year === batteryYear ? batteryReplacementPaise : 0;
      return {
        year,
        energyPaise,
        maintenancePaise,
        insurancePaise,
        interestPaise,
        batteryPaise,
        totalPaise:
          energyPaise +
          maintenancePaise +
          insurancePaise +
          interestPaise +
          batteryPaise,
      };
    },
  );

  const sum = (pick: (y: YearlyCost) => number) =>
    yearly.reduce((acc, y) => acc + pick(y), 0);

  const resaleNominalPaise = Math.round(
    (variant.exShowroomPaise * residualAtExit.pct) / 100,
  );
  const resaleCreditPaise = Math.round(
    resaleNominalPaise /
      (1 + tables.discountRatePct / 100) ** ownershipYears,
  );
  if (tables.discountRatePct > 0) {
    assumptions.add(
      `The resale value is credited at what it is worth today, discounted at ${tables.discountRatePct}% a year. Running costs are quoted in the rupees of the year they fall.`,
    );
  }
  if (TCO_CONVENTIONS.priceEscalationPct === 0) {
    assumptions.add(
      `Fuel, electricity and service prices are held at their ${energyPrice.asOf} levels for the whole ${ownershipYears}-year horizon.`,
    );
  }

  const acquisitionPaise = price.onRoadPaise + processingFeePaise;
  const totalPaise =
    acquisitionPaise + sum((y) => y.totalPaise) - resaleCreditPaise;

  return {
    ok: true,
    tco: {
      variantId: variant.variantId,
      ownershipYears,
      totalKm,
      acquisitionPaise,
      energyPaise: sum((y) => y.energyPaise),
      maintenancePaise: sum((y) => y.maintenancePaise),
      insuranceRenewalPaise: sum((y) => y.insurancePaise),
      financingInterestPaise,
      batteryReplacementPaise,
      resaleNominalPaise,
      resaleCreditPaise,
      totalPaise,
      costPaisePerKm: totalKm > 0 ? totalPaise / totalKm : 0,
      yearly,
      assumptions: [...assumptions],
    },
  };
}

/**
 * The month at which a candidate's cumulative spend falls below a baseline's —
 * the "when does the pricier, cheaper-to-run one pay off" question.
 *
 * Resale is excluded on both sides: it is realised only on exit, and folding it
 * into a running total would let a vehicle "break even" on money the owner has
 * not yet seen. Within a year, costs are spread evenly across its months.
 *
 * Returns 0 when the candidate is cheaper from the outset, and `null` when it
 * never catches up inside the horizon — which is a real answer, not a failure.
 */
export function breakEvenMonth(
  candidate: TcoBreakdown,
  baseline: TcoBreakdown,
): number | null {
  const months = Math.min(candidate.ownershipYears, baseline.ownershipYears) * 12;

  const cumulativeAt = (tco: TcoBreakdown, month: number): number => {
    let total = tco.acquisitionPaise;
    for (let i = 0; i < tco.yearly.length; i += 1) {
      const elapsed = Math.min(12, Math.max(0, month - i * 12));
      total += (tco.yearly[i].totalPaise * elapsed) / 12;
    }
    return total;
  };

  for (let month = 0; month <= months; month += 1) {
    if (cumulativeAt(candidate, month) <= cumulativeAt(baseline, month)) {
      return month;
    }
  }
  return null;
}
