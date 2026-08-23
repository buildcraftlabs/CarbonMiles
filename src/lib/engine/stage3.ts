import type { CandidateVariant, InfraSnapshot } from "./candidate";
import type { Co2Breakdown } from "./co2";
import type { CommercialEconomics } from "./commercial";
import type { FuelType, StationType } from "./enums";
import type { OnRoadPrice } from "./on-road";
import { isCommercial, type RecommendationProfile } from "./profile";
import { GATE_THRESHOLDS } from "./stage1";
import type { TcoBreakdown } from "./tco";

/**
 * Stage 3 — sub-score normalisation and persona weighting.
 *
 * Stage 2 produces figures in incompatible units: rupees over a horizon, grams
 * per kilometre, months to payback, a count of service centres. They cannot be
 * added. This stage puts each on a common 0–100 scale **relative to the
 * candidate set**, then combines them with weights derived from the profile.
 *
 * **Normalisation is min–max across the survivors, not against an absolute
 * scale.** There is no defensible absolute: a ₹12L five-year TCO is excellent
 * for a seven-seater and poor for a hatchback, and the only honest reading of
 * "cheap" is "cheap among the vehicles this buyer can actually buy". Stage 1
 * has already bounded the set by the user's own budget, which is what keeps the
 * range from being set by an outlier nobody was ever going to buy.
 *
 * A consequence worth stating plainly: **the scores are not portable.** The
 * same vehicle scored against a different candidate set gets a different
 * number. They rank; they do not grade. `range` is carried on every sub-score
 * so the payload can say what the number was measured against.
 *
 * **Missing data is never imputed.** A candidate with no service-centre count
 * scores `null` on reliability and has that dimension's weight redistributed
 * across the dimensions it *can* be scored on, rather than being handed a
 * middling 50 that would rank it against vehicles we actually know something
 * about. Same doctrine as stage 2: a wrong number is worse than a missing one,
 * because a wrong number ranks.
 *
 * No database access, no clock, no LLM. Given the same input this returns the
 * same scores forever, which is what makes a stored run replayable (FR-A12).
 */

/**
 * The axes a vehicle is judged on.
 *
 * Three are category-exclusive. `cost` is scored for passenger buyers only and
 * `profitability`/`payback` for commercial ones — see
 * `SCORING_CONVENTIONS.commercialCostIsNotDoubleCounted` for why scoring both
 * would be counting the same signal twice.
 */
export const SCORE_DIMENSIONS = [
  "cost",
  "profitability",
  "payback",
  "usage",
  "infrastructure",
  "environment",
  "reliability",
  "resale",
] as const;

export type ScoreDimension = (typeof SCORE_DIMENSIONS)[number];

export type ScoreDirection = "lower_is_better" | "higher_is_better";

/**
 * Modelling conventions that are ours rather than sourced. Exported so the
 * explainability payload can state them instead of burying them.
 */
export const SCORING_CONVENTIONS = {
  /**
   * For a commercial buyer, net margin per kilometre is
   * `revenue/km − driver/km − TCO/km`, and the first two terms are constants
   * of the profile. Normalised across a candidate set, a profitability score
   * built on it is therefore the *exact* mirror of a cost score built on
   * `costPaisePerKm` — scoring both would give the same signal two weights
   * wearing different names. Payback is kept because it turns on the *shape*
   * of the cost curve against accruing revenue, not just its total, so it can
   * and does order candidates differently.
   */
  commercialCostIsNotDoubleCounted: true,
  /**
   * The environment weight is expressed relative to the money weight, because
   * that is what `preferences.environmentWeight` is documented to mean: 0
   * decides on money alone, 1 weights CO2 as heavily as cost. For a commercial
   * profile the money weight is profitability plus payback together.
   */
  environmentWeightIsRelativeToMoney: true,
  /**
   * Biogenic tailpipe carbon is excluded from the environment sub-score. The
   * score normalises `gramsCo2ePerKm`, which is the counted figure;
   * `biogenicGramsCo2PerKm` is reported beside it and never inside it, exactly
   * as `CO2_CONVENTIONS.countBiogenicCarbon` requires. Folding it in here
   * would reverse that decision at the one place where it changes a ranking.
   */
  environmentExcludesBiogenicCarbon: true,
  /**
   * Range headroom is scored under usage, not infrastructure, and only for
   * electric vehicles. A petrol tank's range is not a constraint on how the
   * vehicle can be used — the pump network is, and the network is precisely
   * what the infrastructure sub-score already measures.
   */
  rangeHeadroomScoredForElectricOnly: true,
  /**
   * Where every candidate carries the same value on a dimension, that
   * dimension cannot separate them. All of them score `NEUTRAL_SCORE` and the
   * sub-score is flagged `discriminating: false`. It cannot change the order,
   * so the choice of constant is a reporting decision, not a ranking one.
   */
  degenerateDimensionScoresNeutral: true,
} as const;

/** The score given when a dimension holds no information about the ordering. */
export const NEUTRAL_SCORE = 50;

/**
 * Shape parameters for the two composite "fit" indices. Exported as data so the
 * payload can cite the number that shaped a score rather than restating it.
 */
export const FIT_PARAMETERS = {
  /** Points lost per seat beyond what the buyer said they need. Surplus seats
   * are paid for in price, fuel and parking, every day, by someone who did not
   * want them. */
  seatSurplusPenalty: 8,
  /** Points lost per 1.0 of surplus payload ratio — a 2 t vehicle against a
   * 1 t requirement is a ratio of 1.0. Over-trucking is the commercial
   * equivalent of surplus seats and costs the same way. */
  payloadSurplusPenalty: 40,
  /** Neither penalty may take a capacity fit below this. A vehicle bigger than
   * you need is a compromise, not a disqualification — and stage 1 has already
   * removed everything *smaller* than you need. */
  capacityFitFloor: 40,
  /** Usable range this many times the distance between charges scores full
   * marks. Two round trips without thinking about it is the point at which
   * range stops being something the driver plans around. */
  comfortableRangeRatio: 2,
  /** What a ratio of exactly 1.0 scores — the vehicle just covers the distance
   * with the gate's headroom already allowed for, and nothing spare. */
  adequateRangeScore: 40,
  /**
   * What petrol and diesel score when we hold no density reading for the
   * location. Not 100: it is an absence of evidence, not evidence of a pump.
   * High because a fuel gated only by data we do not have is not a fuel the
   * buyer will struggle to buy.
   */
  ubiquitousFuelScore: 95,
  /**
   * The floor a home charger puts under an electric vehicle's infrastructure
   * score. A vehicle that leaves full every morning is not living off the
   * public network; it is the single biggest lever in the whole profile.
   */
  homeChargingFloor: 85,
} as const;

/**
 * Persona weights before the environment weight is derived and before the whole
 * set is renormalised. Each block sums to 1 on its own dimensions.
 *
 * These are a starting position, not a finding. `feedback.disputedVariantId` is
 * the metric that tells us they are wrong (PRD §metrics), and the numbers live
 * here as exported data so that moving them is a one-line change with a test
 * around it rather than an archaeology exercise.
 */
export const BASE_WEIGHTS: Record<
  RecommendationProfile["category"],
  Partial<Record<ScoreDimension, number>>
> = {
  passenger: {
    cost: 0.42,
    usage: 0.18,
    infrastructure: 0.12,
    reliability: 0.16,
    resale: 0.12,
  },
  commercial: {
    profitability: 0.34,
    payback: 0.2,
    usage: 0.14,
    infrastructure: 0.1,
    reliability: 0.14,
    resale: 0.08,
  },
};

/** Which dimensions carry the money signal, per category. The environment
 * weight is expressed as a share of their total. */
const MONEY_DIMENSIONS: Record<
  RecommendationProfile["category"],
  readonly ScoreDimension[]
> = {
  passenger: ["cost"],
  commercial: ["profitability", "payback"],
};

/**
 * Fuels whose retail network is dense enough that an absent density reading
 * says more about our data than about the buyer's street. Mirrors stage 1's
 * `NETWORK_DEPENDENT_FUELS`, from the other side.
 *
 * LPG is deliberately not here. It is not gated in stage 1 either, but for the
 * opposite reason: LPG retail is not tracked at all, and "we have no data" is
 * not the same claim as "there is a pump on every corner". An LPG variant goes
 * unscored on infrastructure and has the weight redistributed.
 */
const UBIQUITOUS_FUELS: readonly FuelType[] = [
  "petrol",
  "diesel",
  "hybrid_mild",
  "hybrid_strong",
  "plugin_hybrid",
  "flex_fuel",
];

/**
 * The `infra_density` row that governs a fuel's access score.
 *
 * Every hybrid maps to the petrol network, plug-ins included: a plug-in hybrid
 * with nowhere to charge is an inefficient petrol car, not an undriveable one,
 * so its access is bounded by the pump rather than by the charger.
 */
const STATION_TYPE_BY_FUEL: Partial<Record<FuelType, StationType>> = {
  petrol: "petrol",
  diesel: "diesel",
  hybrid_mild: "petrol",
  hybrid_strong: "petrol",
  plugin_hybrid: "petrol",
  flex_fuel: "petrol",
  cng: "cng",
  hydrogen: "hydrogen",
  electric: "ev_dc",
};

/**
 * Everything stage 3 needs about one survivor of stage 1, as plain data.
 *
 * `tco` is required — a candidate that could not be costed has no business
 * being ranked, and stage 2 returns those as typed failures rather than
 * partial breakdowns. Everything else is nullable, and a null costs the
 * candidate that dimension rather than the whole result.
 */
export interface ScoringInput {
  variant: CandidateVariant;
  /** Carried through from stage 1 so the payload can show what was judged. It
   * feeds no sub-score directly: acquisition is already inside the TCO, and
   * scoring the sticker price as well would weight it twice. */
  price: OnRoadPrice;
  tco: TcoBreakdown;
  /** `null` where no emission factor covered the fuel. */
  co2: Co2Breakdown | null;
  /** Commercial profiles only, and `null` there too if the economics could not
   * be computed. Ignored entirely for a passenger profile. */
  commercial: CommercialEconomics | null;
  /** `manufacturers.serviceCentreCount`. A great vehicle you cannot get
   * serviced in Nashik is not a great vehicle for someone in Nashik. */
  serviceCentreCount: number | null;
  /** `resale_curves.liquidityScore` for the row that priced the residual.
   * A high-residual vehicle nobody buys is not actually liquid. */
  resaleLiquidityScore: number | null;
}

export interface Stage3Input {
  profile: RecommendationProfile;
  candidates: readonly ScoringInput[];
  /** `infra_density` for the user's city, as stage 1 was given it. */
  infra: InfraSnapshot;
}

export interface ScoreRange {
  min: number;
  max: number;
}

export interface SubScore {
  dimension: ScoreDimension;
  /** 0–100 within this candidate set. `null` when this candidate holds no
   * value for the dimension — never a substituted midpoint. */
  score: number | null;
  /** The figure that was normalised, in `unit`. Carried so the arithmetic can
   * be re-done by hand from the payload. */
  raw: number | null;
  unit: string;
  direction: ScoreDirection;
  /** What `raw` was measured against: the spread across every candidate that
   * held a value. `null` when this candidate was not scored. */
  range: ScoreRange | null;
  /** `false` when every candidate tied and the dimension cannot order them. */
  discriminating: boolean;
  /** The weight actually applied to this candidate, after redistribution. */
  weight: number;
  /** Present when the raw figure is a composite index or was substituted. */
  note?: string;
}

export interface ScoredCandidate {
  variantId: string;
  name: string;
  /** 0–100. The weighted mean of the dimensions this candidate could be scored
   * on, with the rest redistributed proportionally. */
  totalScore: number;
  subScores: SubScore[];
  /** Dimensions this candidate carried no value for, and why. */
  unscored: { dimension: ScoreDimension; reason: string }[];
}

export interface Stage3Result {
  /** In input order. Ordering is stage 4's job, not this one's. */
  scored: ScoredCandidate[];
  /** The persona weights, before any per-candidate redistribution. Sums to 1
   * over the dimensions the category scores. */
  weights: Partial<Record<ScoreDimension, number>>;
  /** How those weights were arrived at, in prose the payload can render. */
  weightBasis: string[];
  assumptions: string[];
}

/** Scores are presentation figures and are rounded to two places, so the number
 * in the payload is the number on the card (FR-A11). Weights are rounded to
 * four: at two, a 9.5% environment weight becomes 10% and the claim that it is
 * a quarter of the cost weight stops being checkable from the payload. */
const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * Persona weights (FR-A9 requires the weight that produced a score be shown, so
 * this returns its own reasoning alongside the numbers).
 *
 * Two inputs and no more: the category, which decides *which* dimensions exist,
 * and `preferences.environmentWeight`, which decides how loudly CO2 speaks
 * against money. Everything else in the profile has already had its say — it
 * shaped the TCO, the gates and the fit indices, and letting it move the
 * weights as well would be counting it twice.
 */
export function deriveWeights(profile: RecommendationProfile): {
  weights: Partial<Record<ScoreDimension, number>>;
  basis: string[];
} {
  const base = BASE_WEIGHTS[profile.category];
  const moneyWeight = MONEY_DIMENSIONS[profile.category].reduce(
    (total, dimension) => total + (base[dimension] ?? 0),
    0,
  );

  const environmentWeight = profile.preferences.environmentWeight * moneyWeight;
  const combined: Partial<Record<ScoreDimension, number>> = {
    ...base,
    ...(environmentWeight > 0 ? { environment: environmentWeight } : {}),
  };

  const total = Object.values(combined).reduce(
    (sum, weight) => sum + (weight ?? 0),
    0,
  );

  const weights: Partial<Record<ScoreDimension, number>> = {};
  for (const dimension of SCORE_DIMENSIONS) {
    const weight = combined[dimension];
    if (weight !== undefined && weight > 0) {
      weights[dimension] = round4(weight / total);
    }
  }

  const basis = [
    profile.category === "commercial"
      ? "Commercial profile: profitability and payback carry the most weight, and running cost is not scored separately because net margin per kilometre already is running cost, inverted."
      : "Passenger profile: total cost of ownership over your stated horizon carries the most weight.",
  ];

  if (environmentWeight > 0) {
    const pct = Math.round(profile.preferences.environmentWeight * 100);
    basis.push(
      `You set environmental preference to ${pct}%, so CO2 is weighted at ${pct}% of what money is weighted at.`,
    );
  } else {
    basis.push(
      "You set environmental preference to zero, so CO2 was not scored at all.",
    );
  }

  return { weights, basis };
}

/** One candidate's value on one dimension, before normalisation. */
interface RawSignal {
  value: number | null;
  unit: string;
  direction: ScoreDirection;
  note?: string;
  /** Why there is no value, for the `unscored` list. */
  missingReason?: string;
}

const absent = (unit: string, direction: ScoreDirection, reason: string): RawSignal => ({
  value: null,
  unit,
  direction,
  missingReason: reason,
});

/**
 * Capacity headroom, as a 0–100 index.
 *
 * Stage 1 has already removed everything too small, so this only ever measures
 * surplus. Surplus is a real cost — it is paid in price, in fuel and in parking
 * — but it is not a disqualification, hence the floor.
 */
function capacityFit(
  variant: CandidateVariant,
  profile: RecommendationProfile,
): { value: number; note: string } | null {
  const { capacityFitFloor, seatSurplusPenalty, payloadSurplusPenalty } =
    FIT_PARAMETERS;

  if (isCommercial(profile)) {
    if (variant.payloadKg === null) return null;
    const surplusRatio = Math.max(
      0,
      variant.payloadKg / profile.payloadKg - 1,
    );
    return {
      value: clamp(100 - surplusRatio * payloadSurplusPenalty, capacityFitFloor, 100),
      note: `${variant.payloadKg} kg payload against the ${profile.payloadKg} kg you carry.`,
    };
  }

  if (variant.seatingCapacity === null) return null;
  const surplusSeats = Math.max(0, variant.seatingCapacity - profile.passengers);
  return {
    value: clamp(100 - surplusSeats * seatSurplusPenalty, capacityFitFloor, 100),
    note: `${variant.seatingCapacity} seats against the ${profile.passengers} you need.`,
  };
}

/**
 * Electric range headroom, as a 0–100 index.
 *
 * Measured against the same distance stage 1's gate used — the larger of the
 * daily total and the typical single trip — and against the same 20% headroom,
 * so a vehicle that only just cleared the gate cannot then score as if range
 * were comfortable.
 */
function rangeFit(
  variant: CandidateVariant,
  profile: RecommendationProfile,
): { value: number; note: string } | null {
  if (variant.realWorldRangeKm === null) return null;

  const kmBetweenCharges = Math.max(
    profile.usage.dailyKm,
    profile.usage.typicalTripKm,
  );
  if (kmBetweenCharges <= 0) return null;

  const usableKm = variant.realWorldRangeKm * GATE_THRESHOLDS.evRangeUtilisation;
  const ratio = usableKm / kmBetweenCharges;
  const { comfortableRangeRatio, adequateRangeScore } = FIT_PARAMETERS;

  const value =
    ratio >= 1
      ? clamp(
          adequateRangeScore +
            ((100 - adequateRangeScore) * (ratio - 1)) /
              (comfortableRangeRatio - 1),
          adequateRangeScore,
          100,
        )
      : clamp(adequateRangeScore * ratio, 0, adequateRangeScore);

  return {
    value,
    note: `about ${Math.round(usableKm)} km usable against ${kmBetweenCharges} km between charges.`,
  };
}

/**
 * Refuelling or charging access, as a 0–100 index.
 *
 * A density percentile is pulled toward the neutral midpoint in proportion to
 * how thinly it is evidenced: a bottom-decile reading we barely trust should
 * not sink a vehicle, and a top-decile reading we barely trust should not
 * float one. This is the same instinct as stage 1's confidence floor, applied
 * continuously instead of as a gate.
 */
function infrastructureFit(
  variant: CandidateVariant,
  profile: RecommendationProfile,
  infra: InfraSnapshot,
): { value: number; note: string } | null {
  const { ubiquitousFuelScore, homeChargingFloor } = FIT_PARAMETERS;
  const stationType = STATION_TYPE_BY_FUEL[variant.fuelType];
  const reading =
    stationType === undefined
      ? undefined
      : (infra[stationType] ?? (stationType === "ev_dc" ? infra.ev_ac : undefined));

  const discounted =
    reading === undefined || reading.percentile === null
      ? null
      : NEUTRAL_SCORE +
        (reading.percentile - NEUTRAL_SCORE) * (reading.confidenceScore / 100);

  if (variant.fuelType === "electric") {
    if (profile.charging.homeCharging) {
      return {
        value: Math.max(discounted ?? 0, homeChargingFloor),
        note:
          discounted === null
            ? "you charge at home, and no public charging density is recorded for your city."
            : "you charge at home, so the public network is a backstop rather than the daily plan.",
      };
    }
    if (discounted === null) return null;
    return {
      value: clamp(discounted, 0, 100),
      note: `public fast charging here sits at the ${reading?.percentile}th percentile, discounted for ${reading?.confidenceScore}% source confidence.`,
    };
  }

  if (discounted === null) {
    if (UBIQUITOUS_FUELS.includes(variant.fuelType)) {
      return {
        value: ubiquitousFuelScore,
        note: `no ${variant.fuelType} density recorded for your city; scored on the near-universal retail network.`,
      };
    }
    return null;
  }

  return {
    value: clamp(discounted, 0, 100),
    note: `${variant.fuelType} stations here sit at the ${reading?.percentile}th percentile, discounted for ${reading?.confidenceScore}% source confidence.`,
  };
}

/** Every dimension's raw figure for one candidate, keyed by dimension. */
function rawSignals(
  entry: ScoringInput,
  profile: RecommendationProfile,
  infra: InfraSnapshot,
): Partial<Record<ScoreDimension, RawSignal>> {
  const { variant, tco, co2, commercial } = entry;
  const signals: Partial<Record<ScoreDimension, RawSignal>> = {};

  if (isCommercial(profile)) {
    if (commercial === null) {
      const reason = "the commercial economics could not be computed.";
      signals.profitability = absent("paise/km", "higher_is_better", reason);
      signals.payback = absent("months", "lower_is_better", reason);
    } else {
      signals.profitability = {
        value: commercial.base.netMarginPaisePerKm,
        unit: "paise/km",
        direction: "higher_is_better",
        note: "base case, before the sensitivity band.",
      };
      /**
       * Never paying back inside the horizon is an answer, not a gap: it is
       * scored as one month worse than the worst month that exists, so the
       * vehicle sits below everything that does pay back without the
       * normalisation having to handle an infinity.
       */
      signals.payback = {
        value: commercial.base.paybackMonth ?? commercial.ownershipYears * 12 + 1,
        unit: "months",
        direction: "lower_is_better",
        note:
          commercial.base.paybackMonth === null
            ? `does not pay back within ${commercial.ownershipYears} years; scored one month past the horizon.`
            : "base case, before the sensitivity band.",
      };
    }
  } else {
    signals.cost = {
      value: tco.totalPaise,
      unit: "paise",
      direction: "lower_is_better",
      note: `total cost of ownership over ${tco.ownershipYears} years and ${tco.totalKm} km, net of resale.`,
    };
  }

  const capacity = capacityFit(variant, profile);
  const range =
    variant.fuelType === "electric" ? rangeFit(variant, profile) : null;

  if (capacity === null) {
    signals.usage = absent(
      "index",
      "higher_is_better",
      isCommercial(profile)
        ? "payload is not published for this variant."
        : "seating capacity is not published for this variant.",
    );
  } else if (range === null) {
    signals.usage = {
      value: capacity.value,
      unit: "index",
      direction: "higher_is_better",
      note:
        variant.fuelType === "electric"
          ? `Capacity fit only — ${capacity.note} Real-world range is not published, so range headroom was not scored.`
          : `Capacity fit — ${capacity.note}`,
    };
  } else {
    signals.usage = {
      value: (capacity.value + range.value) / 2,
      unit: "index",
      direction: "higher_is_better",
      note: `Capacity fit and range headroom, averaged — ${capacity.note} Range: ${range.note}`,
    };
  }

  const access = infrastructureFit(variant, profile, infra);
  signals.infrastructure =
    access === null
      ? absent(
          "index",
          "higher_is_better",
          `no ${variant.fuelType} infrastructure data for your city.`,
        )
      : {
          value: access.value,
          unit: "index",
          direction: "higher_is_better",
          note: `Access — ${access.note}`,
        };

  signals.environment =
    co2 === null
      ? absent(
          "g CO2e/km",
          "lower_is_better",
          "no emission factor covers this fuel for your state.",
        )
      : {
          value: co2.gramsCo2ePerKm,
          unit: "g CO2e/km",
          direction: "lower_is_better",
          note: `well-to-wheel, ${co2.scope}. Biogenic carbon is reported separately and is not counted here.`,
        };

  signals.reliability =
    entry.serviceCentreCount === null
      ? absent(
          "centres",
          "higher_is_better",
          "we hold no service-centre count for this manufacturer.",
        )
      : {
          value: entry.serviceCentreCount,
          unit: "centres",
          direction: "higher_is_better",
          note: "authorised service centres nationally.",
        };

  signals.resale =
    entry.resaleLiquidityScore === null
      ? absent(
          "index",
          "higher_is_better",
          "we hold no used-market liquidity score for this segment and fuel.",
        )
      : {
          value: entry.resaleLiquidityScore,
          unit: "index",
          direction: "higher_is_better",
          note: "how readily this segment and fuel actually sells used.",
        };

  return signals;
}

/**
 * Stage 3 end to end.
 *
 * Two passes, and they cannot be collapsed into one: the range a candidate is
 * scored against is a property of the whole set, so every raw figure has to
 * exist before any score can.
 */
export function runStage3(input: Stage3Input): Stage3Result {
  const { profile, candidates, infra } = input;
  const { weights, basis } = deriveWeights(profile);
  const assumptions = new Set<string>();

  const signals = candidates.map((entry) => rawSignals(entry, profile, infra));

  const ranges = new Map<ScoreDimension, ScoreRange>();
  const degenerate = new Set<ScoreDimension>();
  for (const dimension of SCORE_DIMENSIONS) {
    if (weights[dimension] === undefined) continue;
    const values = signals
      .map((set) => set[dimension]?.value)
      .filter((value): value is number => value !== null && value !== undefined);
    if (values.length === 0) continue;
    const range = { min: Math.min(...values), max: Math.max(...values) };
    ranges.set(dimension, range);
    if (range.max === range.min) degenerate.add(dimension);
  }

  const scored: ScoredCandidate[] = candidates.map((entry, index) => {
    const set = signals[index];
    const subScores: SubScore[] = [];
    const unscored: ScoredCandidate["unscored"] = [];

    /** First pass over this candidate: score what can be scored, and note the
     * weight each scored dimension would carry before redistribution. */
    const scoreable: { dimension: ScoreDimension; score: number; weight: number }[] =
      [];

    for (const dimension of SCORE_DIMENSIONS) {
      const weight = weights[dimension];
      if (weight === undefined) continue;

      const signal = set[dimension];
      const range = ranges.get(dimension);

      if (signal === undefined || signal.value === null || range === undefined) {
        const reason =
          signal?.missingReason ??
          "no candidate in this set carries a value for it.";
        unscored.push({ dimension, reason });
        subScores.push({
          dimension,
          score: null,
          raw: null,
          unit: signal?.unit ?? "index",
          direction: signal?.direction ?? "higher_is_better",
          range: null,
          discriminating: range !== undefined && !degenerate.has(dimension),
          weight: 0,
          note: `Not scored: ${reason}`,
        });
        continue;
      }

      const score = degenerate.has(dimension)
        ? NEUTRAL_SCORE
        : signal.direction === "higher_is_better"
          ? (100 * (signal.value - range.min)) / (range.max - range.min)
          : (100 * (range.max - signal.value)) / (range.max - range.min);

      scoreable.push({ dimension, score, weight });
      subScores.push({
        dimension,
        score: round2(score),
        raw: signal.value,
        unit: signal.unit,
        direction: signal.direction,
        range,
        discriminating: !degenerate.has(dimension),
        weight: 0,
        note: signal.note,
      });

      if (degenerate.has(dimension)) {
        assumptions.add(
          `Every remaining vehicle scored the same on ${dimension}, so it could not separate them and each was given ${NEUTRAL_SCORE}.`,
        );
      }
    }

    /** Second pass: redistribute the weight of everything unscored across
     * what was, so a data gap neither penalises this candidate nor quietly
     * shrinks its total. */
    const scoreableWeight = scoreable.reduce((sum, item) => sum + item.weight, 0);
    let totalScore = 0;
    for (const item of scoreable) {
      const weight = scoreableWeight > 0 ? item.weight / scoreableWeight : 0;
      totalScore += item.score * weight;
      const subScore = subScores.find((s) => s.dimension === item.dimension);
      if (subScore !== undefined) subScore.weight = round4(weight);
    }

    for (const gap of unscored) {
      assumptions.add(
        `${entry.variant.name} was not scored on ${gap.dimension} — ${gap.reason} Its weight was spread across the dimensions we could score.`,
      );
    }

    return {
      variantId: entry.variant.variantId,
      name: entry.variant.name,
      totalScore: round2(totalScore),
      subScores,
      unscored,
    };
  });

  if (candidates.length === 1) {
    assumptions.add(
      "Only one vehicle survived the filters. Scores are relative to the candidate set, so with nothing to compare against every dimension scored neutral.",
    );
  }

  return { scored, weights, weightBasis: basis, assumptions: [...assumptions] };
}
