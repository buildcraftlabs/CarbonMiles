import type { CommercialProfile } from "./profile";
import type { TcoBreakdown } from "./tco";

/**
 * Stage 2b — commercial economics: margin, payback, ROI, and the band around
 * all three.
 *
 * A fleet buyer is not asking "which vehicle is nicer", they are asking "does
 * this thing pay for itself, and when". That question needs two numbers the
 * passenger path never sees — what the vehicle earns per kilometre, and what
 * the driver costs — and both of them vary more between two operators running
 * the same route than most vehicles vary between each other.
 *
 * So the headline of this module is not the base case, it is the band. Freight
 * rates move with season, fuel, lane and who you are contracted to; driver pay
 * moves with city and duty cycle. Quoting a single payback month off one stated
 * rate is false precision dressed as an answer. We compute low, base and high,
 * and when the band spans both loss and profit we say so in the output rather
 * than let the base case imply a confidence the inputs do not support.
 *
 * Everything here builds on a `TcoBreakdown` that `computeTco` already
 * produced. The cost curve is not rebuilt: the same `yearly` series that costs
 * the vehicle is the series payback is measured against, so the two can never
 * drift apart. Driver cost is the one recurring cost that is *not* in the TCO,
 * because it is not a cost of owning the vehicle, it is a cost of operating it.
 *
 * As in stage 2, anything that cannot be computed is returned as a typed
 * failure with a reason. A guessed ROI is worse than a missing one, because a
 * guessed ROI ranks.
 */

/** The duty cycles the commercial profile distinguishes. */
export type DutyCycle = CommercialProfile["dutyCycle"];

/**
 * How far either side of the stated figures the sensitivity band reaches.
 *
 * This is an **input**, not a constant, and it is the whole point of the
 * module. An operator on a contracted annual rate knows their revenue to within
 * a couple of percent; one on spot intercity freight does not know it to within
 * twenty. Only they can tell us which they are, so we take it from them and
 * fall back to a documented default when they do not say.
 */
export interface SensitivityRange {
  /** Percent the freight rate may swing either side of the stated figure. */
  revenueSwingPct: number;
  /** Percent driver pay may swing either side of the stated figure. */
  driverCostSwingPct: number;
}

/**
 * Fallback swings when the caller states no range of their own.
 *
 * These are **our modelling convention, not sourced rates**. They encode one
 * defensible observation — that rate volatility rises as you move from a
 * contracted last-mile drop rate towards spot intercity freight, and that
 * driver pay moves less than freight rates do because wages are sticky and
 * freight is not. They are deliberately wide. A caller holding real contracted
 * rates should pass their own range and get a tighter, better answer.
 */
export const DEFAULT_SENSITIVITY_BY_DUTY_CYCLE: Record<
  DutyCycle,
  SensitivityRange
> = {
  /** Per-drop rates, usually contracted and renegotiated annually. */
  last_mile: { revenueSwingPct: 10, driverCostSwingPct: 10 },
  /** Contracted, but exposed to fuel-linked rate revisions mid-term. */
  urban_distribution: { revenueSwingPct: 15, driverCostSwingPct: 10 },
  /** Spot freight: swings with season, lane, diesel and return-load luck. */
  intercity: { revenueSwingPct: 25, driverCostSwingPct: 15 },
  /** Between the two, because a mixed operator is exposed to both. */
  mixed: { revenueSwingPct: 20, driverCostSwingPct: 12 },
};

/** Modelling conventions that are ours, not sourced. Exported so the
 * explainability payload can state them rather than bury them. */
export const COMMERCIAL_CONVENTIONS = {
  /**
   * The freight rate is held flat across the horizon, exactly as
   * `TCO_CONVENTIONS.priceEscalationPct` holds fuel and service prices flat.
   * Escalating revenue against a flat cost base would manufacture a widening
   * margin out of nothing, and it would do it to every candidate equally —
   * changing every total without changing the order.
   */
  revenueEscalationPct: 0,
  /**
   * ROI is measured against the capital committed to acquire the vehicle, not
   * against the buyer's down payment. Using the down payment is the plausible
   * alternative and we reject it: it flatters a leveraged purchase, so the same
   * vehicle would rank differently on the buyer's financing choice rather than
   * on its own economics. Financing already costs the buyer through the
   * interest leg of the TCO.
   */
  roiDenominator: "acquisition" as const,
  /**
   * Payback excludes the resale credit, the same doctrine `breakEvenMonth`
   * applies: resale is realised only on exit, and folding it into a running
   * total would let a vehicle "pay back" on money the operator has not yet
   * seen. ROI, which is measured over the completed horizon, does include it.
   */
  paybackExcludesResale: true,
  /**
   * The low case pairs the worst freight rate with the worst driver cost, and
   * the high case pairs the best with the best. Varying one at a time is the
   * plausible alternative and it understates the spread — a bad year is not a
   * year in which only one input moves against you.
   */
  bandPairsInputsAdversely: true,
} as const;

export type ScenarioLabel = "low" | "base" | "high";

export interface CommercialScenario {
  label: ScenarioLabel;
  /** The two inputs this scenario was run at, so the reader can see what moved. */
  revenuePaisePerKm: number;
  driverCostPaisePerMonth: number;
  grossRevenuePaise: number;
  /** Driver pay over the whole horizon. Zero for an owner-driver. */
  driverCostPaise: number;
  /** Recurring cost of running the vehicle — the TCO's yearly series plus the
   * driver. Excludes acquisition and ignores the resale credit. */
  operatingCostPaise: number;
  /** What the vehicle earns above what it costs to run, before capital. */
  operatingMarginPaise: number;
  operatingMarginPctOfRevenue: number;
  /** After acquisition and after crediting the residual: the whole-horizon
   * answer to "did buying this make money". */
  netProfitPaise: number;
  /** The number a fleet operator actually thinks in. */
  netMarginPaisePerKm: number;
  roiPct: number;
  /** `null` means it never pays back inside the horizon — a real answer. */
  paybackMonth: number | null;
}

export interface CommercialEconomics {
  variantId: string;
  ownershipYears: number;
  totalKm: number;
  /** Capital the ROI is measured against — the TCO's acquisition leg. */
  capitalPaise: number;
  /** A sanity figure for the operator to check the profile against. It drives
   * nothing: revenue is per kilometre, so how those kilometres are spread
   * across the month changes no total. */
  kmPerOperatingDay: number;
  base: CommercialScenario;
  low: CommercialScenario;
  high: CommercialScenario;
  /** The band spans an operation that does not cover its running costs and one
   * that does. The starkest form of "it depends". */
  operatingMarginStraddlesZero: boolean;
  /** The band spans a purchase that loses money over the horizon and one that
   * makes it. A buyer must see this rather than the base case alone. */
  netProfitStraddlesZero: boolean;
  /** The range actually used, whether supplied or defaulted. */
  sensitivity: SensitivityRange;
  /** Whether that range came from the caller or from our duty-cycle default. */
  sensitivitySource: "supplied" | "duty_cycle_default";
  assumptions: string[];
}

export type CommercialFailureCode =
  | "profile_mismatch"
  | "distance_missing"
  | "revenue_rate_missing"
  | "capital_missing"
  | "sensitivity_range_invalid";

export type CommercialResult =
  | { ok: true; economics: CommercialEconomics }
  | {
      ok: false;
      variantId: string;
      code: CommercialFailureCode;
      reason: string;
    };

export interface CommercialInput {
  profile: CommercialProfile;
  /** Produced by `computeTco` for **this** profile. The pairing is checked, not
   * trusted: a breakdown costed over a different horizon or distance would
   * produce a margin on kilometres nobody drives. */
  tco: TcoBreakdown;
  /** Omit to use `DEFAULT_SENSITIVITY_BY_DUTY_CYCLE` for the profile's duty
   * cycle. Supply it whenever you hold real rate history — it is the input the
   * whole band hangs on. */
  sensitivity?: SensitivityRange;
}

const fail = (
  variantId: string,
  code: CommercialFailureCode,
  reason: string,
): CommercialResult => ({ ok: false, variantId, code, reason });

/** Recurring cost inside the horizon: the TCO's own yearly series, summed.
 * Reused rather than re-derived so the cost curve payback races against is
 * literally the one that costed the vehicle. */
const recurringCostOf = (tco: TcoBreakdown): number =>
  tco.yearly.reduce((total, year) => total + year.totalPaise, 0);

/**
 * The month cumulative earnings overtake cumulative spend.
 *
 * This is a different question from `breakEvenMonth` in tco.ts, which compares
 * one vehicle's spend against another's. Nothing here is relative to a rival:
 * the vehicle races its own revenue.
 *
 * Spend is acquisition plus the TCO's yearly costs plus driver pay; within a
 * year the yearly figure is spread evenly across its months, as `breakEvenMonth`
 * does. Earnings accrue evenly with distance. The resale credit is excluded —
 * see `COMMERCIAL_CONVENTIONS.paybackExcludesResale`.
 *
 * Returns `null` when it never pays back inside the horizon. That is a real
 * answer and arguably the most useful one this module produces.
 */
export function paybackMonth(
  tco: TcoBreakdown,
  revenuePaisePerKm: number,
  driverCostPaisePerMonth: number,
): number | null {
  const months = tco.ownershipYears * 12;
  if (months <= 0 || tco.totalKm <= 0 || revenuePaisePerKm <= 0) return null;

  const revenuePerMonth = (revenuePaisePerKm * tco.totalKm) / months;

  const spendAt = (month: number): number => {
    let total = tco.acquisitionPaise + driverCostPaisePerMonth * month;
    for (let i = 0; i < tco.yearly.length; i += 1) {
      const elapsed = Math.min(12, Math.max(0, month - i * 12));
      total += (tco.yearly[i].totalPaise * elapsed) / 12;
    }
    return total;
  };

  for (let month = 0; month <= months; month += 1) {
    if (revenuePerMonth * month >= spendAt(month)) return month;
  }
  return null;
}

export function computeCommercialEconomics(
  input: CommercialInput,
): CommercialResult {
  const { profile, tco } = input;
  const { variantId } = tco;
  const assumptions = new Set<string>();

  // --- the breakdown must belong to this profile
  const expectedKm = profile.usage.monthlyKm * 12 * profile.ownershipYears;
  if (
    tco.ownershipYears !== profile.ownershipYears ||
    tco.totalKm !== expectedKm
  ) {
    return fail(
      variantId,
      "profile_mismatch",
      `This cost breakdown covers ${tco.ownershipYears} years and ${tco.totalKm} km, but the profile states ${profile.ownershipYears} years and ${expectedKm} km. Margin computed across that gap would be earned on kilometres nobody drives.`,
    );
  }

  if (tco.totalKm <= 0) {
    return fail(
      variantId,
      "distance_missing",
      "The profile states no distance, so there are no kilometres to earn on and no payback to find.",
    );
  }

  // --- the freight rate
  /** Zero is not an owner-driver's zero. A vehicle that earns nothing per
   * kilometre has no margin, no payback and no ROI, which is the entire
   * question a commercial buyer came to ask. Refuse rather than return zeroes
   * that read as an answer. */
  const { revenuePaisePerKm } = profile;
  if (revenuePaisePerKm <= 0) {
    return fail(
      variantId,
      "revenue_rate_missing",
      "No freight rate was stated, so margin, payback and ROI cannot be computed. They are not assumed from the duty cycle.",
    );
  }

  if (tco.acquisitionPaise <= 0) {
    return fail(
      variantId,
      "capital_missing",
      "The acquisition cost is zero, so there is no capital at risk to measure a return against.",
    );
  }

  // --- the band
  const supplied = input.sensitivity;
  const sensitivity =
    supplied ?? DEFAULT_SENSITIVITY_BY_DUTY_CYCLE[profile.dutyCycle];
  const swingsValid = [
    sensitivity.revenueSwingPct,
    sensitivity.driverCostSwingPct,
  ].every((pct) => Number.isFinite(pct) && pct >= 0 && pct <= 100);
  if (!swingsValid) {
    return fail(
      variantId,
      "sensitivity_range_invalid",
      "Sensitivity swings must be between 0% and 100%. A swing past 100% would put the freight rate below zero, which is not a band, it is a contradiction.",
    );
  }

  // --- the arithmetic, once per scenario
  const horizonMonths = tco.ownershipYears * 12;
  const recurringPaise = recurringCostOf(tco);

  const scenarioAt = (
    label: ScenarioLabel,
    ratePaisePerKm: number,
    driverPaisePerMonth: number,
  ): CommercialScenario => {
    const grossRevenuePaise = Math.round(ratePaisePerKm * tco.totalKm);
    const driverCostPaise = driverPaisePerMonth * horizonMonths;
    const operatingCostPaise = recurringPaise + driverCostPaise;
    const operatingMarginPaise = grossRevenuePaise - operatingCostPaise;
    /** `tco.totalPaise` already carries acquisition and nets off the resale
     * credit, so adding the driver is the whole of what the TCO does not
     * cover. */
    const netProfitPaise = grossRevenuePaise - (tco.totalPaise + driverCostPaise);

    return {
      label,
      revenuePaisePerKm: ratePaisePerKm,
      driverCostPaisePerMonth: driverPaisePerMonth,
      grossRevenuePaise,
      driverCostPaise,
      operatingCostPaise,
      operatingMarginPaise,
      operatingMarginPctOfRevenue:
        (operatingMarginPaise / grossRevenuePaise) * 100,
      netProfitPaise,
      netMarginPaisePerKm: netProfitPaise / tco.totalKm,
      roiPct: (netProfitPaise / tco.acquisitionPaise) * 100,
      paybackMonth: paybackMonth(tco, ratePaisePerKm, driverPaisePerMonth),
    };
  };

  const driverBase = profile.driverCostPaisePerMonth;
  const swing = (value: number, pct: number, direction: 1 | -1) =>
    Math.round(value * (1 + (direction * pct) / 100));

  const base = scenarioAt("base", revenuePaisePerKm, driverBase);
  /** Adversely paired: the worst rate meets the worst wage bill. See
   * `COMMERCIAL_CONVENTIONS.bandPairsInputsAdversely`. */
  const low = scenarioAt(
    "low",
    swing(revenuePaisePerKm, sensitivity.revenueSwingPct, -1),
    swing(driverBase, sensitivity.driverCostSwingPct, 1),
  );
  const high = scenarioAt(
    "high",
    swing(revenuePaisePerKm, sensitivity.revenueSwingPct, 1),
    swing(driverBase, sensitivity.driverCostSwingPct, -1),
  );

  const operatingMarginStraddlesZero =
    low.operatingMarginPaise < 0 && high.operatingMarginPaise > 0;
  const netProfitStraddlesZero =
    low.netProfitPaise < 0 && high.netProfitPaise > 0;

  // --- what the reader has to be told
  assumptions.add(
    `The freight rate of ${revenuePaisePerKm} paise/km is held flat for the whole ${tco.ownershipYears}-year horizon, matching the cost side, which holds fuel and service prices flat too.`,
  );
  assumptions.add(
    supplied
      ? `The band varies the freight rate by ±${sensitivity.revenueSwingPct}% and driver pay by ±${sensitivity.driverCostSwingPct}%, the range you supplied.`
      : `No rate range was supplied, so the band varies the freight rate by ±${sensitivity.revenueSwingPct}% and driver pay by ±${sensitivity.driverCostSwingPct}% — our default for a ${profile.dutyCycle.replace(/_/g, " ")} duty cycle, not a sourced figure. Supply your own contracted rates for a tighter answer.`,
  );
  assumptions.add(
    "The low case pairs the worst freight rate with the highest driver pay and the high case pairs the best with the lowest, because the inputs do not politely take turns moving against an operator.",
  );
  assumptions.add(
    driverBase === 0
      ? "No driver cost was stated, so this is costed as an owner-driven vehicle: the operator's own time is not charged, and the band moves on the freight rate alone."
      : `Driver pay of ${driverBase} paise/month is the stated figure, held flat across the horizon and charged for every month of it, including any the vehicle stands idle.`,
  );
  assumptions.add(
    "Payback is the month cumulative earnings overtake cumulative spend. The resale value is left out of it — it is money the operator has not yet seen — but it is credited in the ROI, which is measured over the completed horizon.",
  );
  assumptions.add(
    `ROI is measured against the ${tco.acquisitionPaise} paise committed to acquire the vehicle, not against a down payment, so a financed and a cash purchase of the same vehicle are compared on the same footing.`,
  );
  if (netProfitStraddlesZero || operatingMarginStraddlesZero) {
    assumptions.add(
      "The band spans both loss and profit. At these rates the honest answer is that it depends on the rate you actually get; the base case is one point inside that range, not the answer.",
    );
  }

  return {
    ok: true,
    economics: {
      variantId,
      ownershipYears: tco.ownershipYears,
      totalKm: tco.totalKm,
      capitalPaise: tco.acquisitionPaise,
      kmPerOperatingDay:
        profile.usage.monthlyKm / profile.operatingDaysPerMonth,
      base,
      low,
      high,
      operatingMarginStraddlesZero,
      netProfitStraddlesZero,
      sensitivity,
      sensitivitySource: supplied ? "supplied" : "duty_cycle_default",
      /** The TCO's own assumptions are deliberately not copied in. The
       * breakdown travels alongside this object in the explainability payload,
       * and duplicating them would have the narrator state each one twice. */
      assumptions: [...assumptions],
    },
  };
}
