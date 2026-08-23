import type { FuelType } from "./enums";
import { type RecommendationProfile } from "./profile";
import { blendedEfficiency, type VariantEconomics } from "./tco";

/**
 * Stage 2 — well-to-wheel CO2e (the environmental figure the PRD's result
 * payload carries, and the input the stage-3 environment sub-score normalises).
 *
 * The shape of the calculation is deliberately the same as TCO's: take a
 * real-world efficiency, take a per-unit reference figure, divide, and multiply
 * out over the horizon. Only the reference figure changes — paise per litre
 * becomes grams CO2e per litre.
 *
 * **Units.** Everything in here is grams CO2e. Per-km figures are rates and are
 * left as floats, exactly as `costPaisePerKm` is; the annual and horizon totals
 * are whole grams. Kilograms and tonnes are a presentation concern and are not
 * carried as separate fields, because a second copy of a number is a second
 * number that can drift out of step with the first.
 *
 * **The constants are not in this file, and that is the point.** Petrol at 2.31
 * kg/l, diesel at 2.68, CNG at 2.16 kg/kg and the grid at roughly 0.71 kg/kWh
 * are seed values for `emission_factors`, not literals here. The grid factor in
 * particular moves every year as renewables grow and varies by state by more
 * than it varies year on year — hardcoding it would quietly bias every EV
 * recommendation, in a direction nobody could see from the output, for as long
 * as it took someone to notice the constant was stale. In the database it
 * carries a `sourceId`, an `asOf` and an optional `stateCode`, and the answer
 * changes when the world does.
 *
 * Every figure derives from `realWorldEfficiency*` (FR-A7). The ARAI claims are
 * not on `VariantEconomics`, which is the type this module takes, so there is no
 * path by which they could reach the arithmetic.
 *
 * A variant that cannot be assessed is returned as a typed failure with a
 * reason, not assessed on a guess. Same doctrine as the rest of the engine: a
 * wrong number is worse than a missing one, because a wrong number ranks.
 */

/**
 * Modelling conventions that are ours, not sourced. Exported so the
 * explainability payload can state them rather than bury them.
 */
export const CO2_CONVENTIONS = {
  /**
   * Biogenic tailpipe carbon — the CO2 released by burning the ethanol
   * fraction, which the crop took out of the atmosphere last season — is
   * reported alongside the total, not added to it. This follows the IPCC and
   * GHG Protocol treatment. It is a *reporting convention*, not a claim that
   * the ethanol was free: cultivation, fertiliser, transport and distillation
   * are fossil and are counted in the total.
   */
  countBiogenicCarbon: false,
  /**
   * Losses between the meter and the pack — charger efficiency, and the
   * transmission and distribution losses upstream of it — are not modelled.
   * The grid factor is applied to the kWh the vehicle turns into distance.
   * TCO prices energy on the same basis, and a CO2 figure computed off a
   * different number of kWh than the cost figure would be indefensible in a
   * side-by-side.
   */
  chargingLossPct: 0,
  /**
   * The emission factor is held flat across the horizon. India's grid is
   * decarbonising, so an EV's ten-year figure computed this way is a
   * conservative one — the error runs against the EV, which is the safe
   * direction for a claim we cannot source.
   */
  factorDriftPctPerYear: 0,
  /**
   * Well-to-wheel is the fuel cycle only. The pack's embodied emissions are
   * cradle-to-gate — a different boundary, a different and far shakier body of
   * evidence — and mixing the two in one number would make it comparable to
   * nothing.
   */
  includesEmbodiedEmissions: false,
} as const;

/**
 * One row of `emission_factors`, as plain data.
 *
 * `numeric` columns arrive from pg as strings; the query layer in
 * `src/lib/data/` converts them before calling in here. The engine never
 * imports from `src/db/` — it is a set of pure functions that must run against
 * fixtures with no Postgres in the module graph.
 */
export interface EmissionFactor {
  fuelType: FuelType;
  /** Grams CO2-equivalent per litre, per kg, or per kWh, per `unit`. */
  gramsCo2ePerUnit: number;
  /** `litre`, `kg` or `kwh`. Must match the denominator of the variant's
   * efficiency unit, or the division is meaningless. */
  unit: string;
  /** `well_to_wheel` covers extraction, refining and combustion;
   * `tank_to_wheel` covers combustion alone. Mixing the two across candidates
   * would rank them on different boundaries, so selection filters on it. */
  scope: string;
  /** `null` for the national figure; a state row wins. Grid intensity is the
   * one factor that genuinely varies by state — a coal-heavy state and a
   * hydro-rich one are not the same vehicle. */
  stateCode: string | null;
  /** ISO `YYYY-MM-DD`. Compared as a string, which orders correctly in that
   * format and avoids dragging a timezone into a pure function. */
  asOf: string;
}

/**
 * What the vehicle actually burns, when the caller knows.
 *
 * E20 is 20% ethanol by volume, and it does two entirely separate things that
 * are easy to conflate:
 *
 *   1. **Efficiency falls.** Ethanol carries about a third less energy per
 *      litre than petrol, so a litre of E20 moves the vehicle less far. The
 *      arithmetic loss from E10 to E20 is around 2.5%; observed real-world
 *      losses run wider, roughly 2–6%, because how much of it an engine gives
 *      back depends on how it is tuned. That per-vehicle figure is sourced —
 *      it is `e20_compatibility.mileageDeltaMin/MaxPct` — and arrives here as
 *      `efficiencyPenaltyPct`. This module does not invent it.
 *   2. **The carbon changes character.** The ethanol fraction's tailpipe CO2 is
 *      biogenic. Its well-to-tank emissions — cultivation, fertiliser,
 *      transport, distillation — are fossil and count in full.
 *
 * Both effects are modelled, separately, and both are visible in the output.
 * Nothing here is defaulted: a `Co2Input` with no `blend` is treated as running
 * on neat fossil petrol, because assuming every petrol vehicle in the country
 * is filled with E20 would be a fabrication in exactly the place the product
 * claims to be careful.
 *
 * There is no `ethanol` member of the fuel-type enum — ethanol is a fuel
 * component, not a powertrain — so the ethanol fraction's factors arrive here
 * as plain numbers carrying their own `asOf` rather than as `EmissionFactor`
 * rows.
 */
export interface EthanolBlend {
  /** Ethanol by volume, 0–100. E20 is 20. Sourced: it is the pump grade. */
  ethanolSharePct: number;
  /** The blend the catalogue's real-world efficiency figures were measured on.
   * E10 has been the nationwide pump grade since 2022, so it is usually 10 —
   * but it is stated by the caller, not assumed here. */
  baselineEthanolSharePct: number;
  /**
   * Real-world efficiency loss, in percent, moving from `baselineEthanolSharePct`
   * to `ethanolSharePct`. Applied as given: it describes that specific
   * transition, and rescaling it to some other blend would be inventing a
   * figure out of a sourced one.
   */
  efficiencyPenaltyPct: number;
  /** Counted. Well-to-tank grams CO2e per litre of *neat* ethanol: cultivation,
   * fertiliser, transport, distillation. */
  fossilGramsCo2ePerLitre: number;
  /** Reported, not counted — see `CO2_CONVENTIONS.countBiogenicCarbon`. Grams
   * CO2 per litre of neat ethanol released at the tailpipe. */
  biogenicGramsCo2PerLitre: number;
  asOf: string;
}

/**
 * The variant fields the emissions calculation needs.
 *
 * This is `VariantEconomics` rather than a narrower twin, deliberately. It is
 * the type `blendedEfficiency` is declared against, so the city/highway blend
 * is shared code with TCO rather than a second implementation that could drift
 * — and if the two stages ever disagreed about how far a litre goes, the
 * ₹/km and the g/km on the same result card would contradict each other. Like
 * TCO's, it carries no `claimedEfficiency` field for a calculation to reach.
 */
export type VariantEmissions = VariantEconomics;

export interface EmissionFactorQuery {
  fuelType: FuelType;
  stateCode: string;
  /** The run's as-of date, passed in rather than read from the clock so that a
   * stored run replays to the same numbers (FR-A12). */
  asOf: string;
  /** Defaults to `well_to_wheel`. */
  scope?: string;
}

export interface Co2Breakdown {
  variantId: string;
  ownershipYears: number;
  totalKm: number;
  /** Counted grams CO2e per kilometre. A rate, so left unrounded. */
  gramsCo2ePerKm: number;
  /** Biogenic tailpipe CO2 per kilometre. Reported beside the total, never
   * inside it. Zero unless an ethanol blend was supplied. */
  biogenicGramsCo2PerKm: number;
  /** Whole grams CO2e over one year and over the whole horizon. */
  annualGramsCo2e: number;
  horizonGramsCo2e: number;
  horizonBiogenicGramsCo2: number;
  /** The efficiency the division actually used, after any blend penalty, and
   * the unit it is in. Carried so the arithmetic can be re-done by hand. */
  effectiveEfficiency: number;
  efficiencyUnit: string;
  /** The per-unit figure actually applied, after blending. Equal to
   * `factor.gramsCo2ePerUnit` when there is no blend. */
  appliedGramsCo2ePerUnit: number;
  scope: string;
  /** The row that produced the figure, carried into the explainability payload
   * so the number can be attributed rather than asserted. */
  factor: EmissionFactor;
  blend: EthanolBlend | null;
  assumptions: string[];
}

export type Co2FailureCode =
  | "efficiency_missing"
  | "efficiency_unit_unknown"
  | "emission_factor_missing"
  | "unit_mismatch"
  | "blend_not_applicable"
  | "blend_invalid";

export type Co2Result =
  | { ok: true; co2: Co2Breakdown }
  | { ok: false; variantId: string; code: Co2FailureCode; reason: string };

export interface Co2Input {
  profile: RecommendationProfile;
  variant: VariantEmissions;
  /** Rows mirroring `emission_factors`, unfiltered. Selection happens here so
   * that which row won is visible in the result. */
  factors: readonly EmissionFactor[];
  /**
   * Supplied only when the caller knows what the vehicle is actually filled
   * with. Absent means neat fossil petrol, not E20.
   */
  blend?: EthanolBlend;
  /** The run's as-of date (FR-A12). */
  asOf: string;
  /** Defaults to `well_to_wheel`. */
  scope?: string;
}

const fail = (
  variantId: string,
  code: Co2FailureCode,
  reason: string,
): Co2Result => ({ ok: false, variantId, code, reason });

/** The denominator of an efficiency unit, spelled as `emission_factors.unit`
 * spells it. Unrecognised spellings are a refusal, not a guess. */
const FUEL_UNIT_BY_EFFICIENCY_UNIT: Record<string, string> = {
  kmpl: "litre",
  "km/l": "litre",
  "km/litre": "litre",
  "km/kg": "kg",
  "km/kwh": "kwh",
};

const FACTOR_UNIT_ALIASES: Record<string, string> = {
  l: "litre",
  litre: "litre",
  litres: "litre",
  liter: "litre",
  liters: "litre",
  kg: "kg",
  kilogram: "kg",
  kwh: "kwh",
};

/** The unit a variant's efficiency is denominated in, or `null` if we cannot
 * tell — in which case no factor can be safely matched to it. */
export function fuelUnitOf(efficiencyUnit: string | null): string | null {
  if (efficiencyUnit === null) return null;
  return FUEL_UNIT_BY_EFFICIENCY_UNIT[efficiencyUnit.trim().toLowerCase()] ?? null;
}

/** `emission_factors.unit` normalised to one of `litre` | `kg` | `kwh`. */
export function canonicalFactorUnit(unit: string): string | null {
  return FACTOR_UNIT_ALIASES[unit.trim().toLowerCase()] ?? null;
}

/**
 * Pick the emission factor that governs a fuel in a given state.
 *
 * Rows overlap legitimately — a national figure, a state grid carve-out, and a
 * newer revision of either — so selection is ordered rather than assumed
 * unique: the state-specific row beats the national one, then the most recently
 * effective row wins. Scope is a filter, not a tie-break: a well-to-wheel
 * figure and a tank-to-wheel figure are answers to different questions, and
 * silently substituting one for the other would rank two candidates on
 * different boundaries.
 *
 * Returns `null` when nothing applies, which the caller must treat as "cannot
 * assess", never as "no emissions".
 */
export function selectEmissionFactor(
  rows: readonly EmissionFactor[],
  query: EmissionFactorQuery,
): EmissionFactor | null {
  const scope = query.scope ?? "well_to_wheel";

  const applicable = rows.filter(
    (row) =>
      row.fuelType === query.fuelType &&
      row.scope === scope &&
      (row.stateCode === null || row.stateCode === query.stateCode) &&
      row.asOf <= query.asOf,
  );

  applicable.sort((a, b) => {
    const specificity = Number(b.stateCode !== null) - Number(a.stateCode !== null);
    if (specificity !== 0) return specificity;
    return b.asOf.localeCompare(a.asOf);
  });

  return applicable[0] ?? null;
}

/**
 * Fuels that can be sold as an ethanol blend at an Indian pump. The hybrids are
 * here because a strong hybrid still burns whatever the petrol pump dispenses;
 * only its consumption differs, and that is already in its efficiency figures.
 */
export const ETHANOL_BLENDABLE_FUELS: readonly FuelType[] = [
  "petrol",
  "flex_fuel",
  "hybrid_mild",
  "hybrid_strong",
  "plugin_hybrid",
];

/**
 * The per-litre split of a blend: what counts, and what is reported beside it.
 *
 * The `petrol` emission factor characterises the fossil fraction, so a blend of
 * share `s` is `(1 - s)` of it plus `s` of the ethanol figures. With no blend,
 * `s` is zero and the whole litre is fossil — the conservative reading, which
 * overstates rather than understates.
 */
export function blendPerUnitFactors(
  fossilGramsCo2ePerUnit: number,
  blend: EthanolBlend | null,
): { counted: number; biogenic: number } {
  if (blend === null) return { counted: fossilGramsCo2ePerUnit, biogenic: 0 };

  const share = blend.ethanolSharePct / 100;
  return {
    counted:
      fossilGramsCo2ePerUnit * (1 - share) + blend.fossilGramsCo2ePerLitre * share,
    biogenic: blend.biogenicGramsCo2PerLitre * share,
  };
}

export function computeCo2(input: Co2Input): Co2Result {
  const { profile, variant, factors, asOf } = input;
  const { ownershipYears } = profile;
  const scope = input.scope ?? "well_to_wheel";
  const assumptions = new Set<string>();

  // --- distance. The same basis TCO uses, so ₹/km and g/km describe the same
  // journeys.
  const annualKm = profile.usage.monthlyKm * 12;
  const totalKm = annualKm * ownershipYears;

  // --- units. Establish which unit the division is in before anything else:
  // a per-litre factor applied to a km/kWh efficiency produces a number that is
  // wrong by three orders of magnitude and still ranks.
  const efficiencyUnit = variant.efficiencyUnit;
  const fuelUnit = fuelUnitOf(efficiencyUnit);
  if (efficiencyUnit === null || fuelUnit === null) {
    return fail(
      variant.variantId,
      "efficiency_unit_unknown",
      `Efficiency is published as "${efficiencyUnit ?? "nothing"}", which does not name a unit an emission factor can be matched to.`,
    );
  }

  // --- efficiency. Shared with TCO rather than reimplemented.
  const efficiency = blendedEfficiency(variant, profile.usage.citySharePct);
  if (efficiency === null) {
    return fail(
      variant.variantId,
      "efficiency_missing",
      "No real-world efficiency published, so emissions cannot be computed. ARAI figures are not substituted.",
    );
  }
  if (efficiency.assumption) assumptions.add(efficiency.assumption);
  if (!(efficiency.value > 0)) {
    return fail(
      variant.variantId,
      "efficiency_missing",
      "Published real-world efficiency is not a usable figure.",
    );
  }

  // --- factor
  const factor = selectEmissionFactor(factors, {
    fuelType: variant.fuelType,
    stateCode: profile.location.stateCode,
    asOf,
    scope,
  });
  if (factor === null) {
    return fail(
      variant.variantId,
      "emission_factor_missing",
      `No ${scope} emission factor on file for ${variant.fuelType} as of ${asOf}, so emissions cannot be computed.`,
    );
  }
  if (!(factor.gramsCo2ePerUnit >= 0) || !Number.isFinite(factor.gramsCo2ePerUnit)) {
    return fail(
      variant.variantId,
      "emission_factor_missing",
      `The ${variant.fuelType} emission factor on file is not a usable figure.`,
    );
  }
  if (canonicalFactorUnit(factor.unit) !== fuelUnit) {
    return fail(
      variant.variantId,
      "unit_mismatch",
      `Efficiency is in ${efficiencyUnit} but the ${variant.fuelType} emission factor is per ${factor.unit}; the two cannot be divided.`,
    );
  }

  // --- ethanol blend
  const blend = input.blend ?? null;
  if (blend !== null) {
    if (!ETHANOL_BLENDABLE_FUELS.includes(variant.fuelType) || fuelUnit !== "litre") {
      return fail(
        variant.variantId,
        "blend_not_applicable",
        `An ethanol blend was supplied for a ${variant.fuelType} variant measured in ${efficiencyUnit}, which does not burn blended petrol.`,
      );
    }
    const shareValid =
      blend.ethanolSharePct >= 0 &&
      blend.ethanolSharePct <= 100 &&
      blend.baselineEthanolSharePct >= 0 &&
      blend.baselineEthanolSharePct <= 100;
    const penaltyValid =
      blend.efficiencyPenaltyPct > -100 && blend.efficiencyPenaltyPct < 100;
    if (!shareValid || !penaltyValid) {
      return fail(
        variant.variantId,
        "blend_invalid",
        "The ethanol blend describes a share outside 0–100% or an efficiency penalty that would zero out the vehicle's range.",
      );
    }
  }

  // --- effect one: efficiency falls, because a litre of ethanol carries less
  // energy than a litre of petrol.
  const penaltyPct = blend?.efficiencyPenaltyPct ?? 0;
  const effectiveEfficiency = efficiency.value * (1 - penaltyPct / 100);
  if (!(effectiveEfficiency > 0)) {
    return fail(
      variant.variantId,
      "blend_invalid",
      "The blend's efficiency penalty leaves the vehicle with no usable efficiency.",
    );
  }

  // --- effect two: the carbon in a litre changes composition.
  const perUnit = blendPerUnitFactors(factor.gramsCo2ePerUnit, blend);

  const gramsCo2ePerKm = perUnit.counted / effectiveEfficiency;
  const biogenicGramsCo2PerKm = perUnit.biogenic / effectiveEfficiency;

  // --- assumptions
  assumptions.add(
    `Emissions use the ${factor.stateCode ?? "national"} ${variant.fuelType} factor of ${factor.gramsCo2ePerUnit} g CO2e per ${factor.unit}, dated ${factor.asOf}, on a ${scope.replace(/_/g, "-")} basis.`,
  );
  if (fuelUnit === "kwh") {
    if (factor.stateCode === null) {
      assumptions.add(
        `No ${profile.location.stateCode} grid emission factor is on file, so the national average was used. A coal-heavy state is understated by that and a hydro- or solar-rich one overstated.`,
      );
    }
    assumptions.add(
      `The grid factor is held at its ${factor.asOf} value for the whole ${ownershipYears}-year horizon. India's grid is decarbonising, so the lifetime figure is a conservative one.`,
    );
    assumptions.add(
      "Charging and grid transmission losses are not modelled; the factor is applied to the energy the vehicle turns into distance, on the same basis the running cost is priced.",
    );
  }
  if (CO2_CONVENTIONS.includesEmbodiedEmissions === false) {
    assumptions.add(
      "This is a fuel-cycle figure. Manufacturing the vehicle and its battery is a different accounting boundary and is not included.",
    );
  }

  if (blend !== null) {
    assumptions.add(
      `Fuel is taken to be E${blend.ethanolSharePct} — ${blend.ethanolSharePct}% ethanol by volume — against the E${blend.baselineEthanolSharePct} the published efficiency was measured on.`,
    );
    assumptions.add(
      `Ethanol carries about a third less energy per litre than petrol, so efficiency is reduced by ${blend.efficiencyPenaltyPct}% to ${effectiveEfficiency.toFixed(2)} ${efficiencyUnit}. That penalty is this vehicle's published E20 figure, not a generic one.`,
    );
    assumptions.add(
      `Ethanol's tailpipe carbon is biogenic: ${biogenicGramsCo2PerKm.toFixed(1)} g CO2 per km is reported separately and not added to the total, following the IPCC convention. Growing, transporting and distilling the ethanol is fossil and is in the total.`,
    );
  } else if (
    fuelUnit === "litre" &&
    ETHANOL_BLENDABLE_FUELS.includes(variant.fuelType)
  ) {
    assumptions.add(
      "No ethanol blend was supplied for this vehicle, so every litre is counted as fossil petrol. Where the pump actually sells E10 or E20 this overstates the figure; it is never understated by default.",
    );
  }

  return {
    ok: true,
    co2: {
      variantId: variant.variantId,
      ownershipYears,
      totalKm,
      gramsCo2ePerKm,
      biogenicGramsCo2PerKm,
      annualGramsCo2e: Math.round(annualKm * gramsCo2ePerKm),
      horizonGramsCo2e: Math.round(totalKm * gramsCo2ePerKm),
      horizonBiogenicGramsCo2: Math.round(totalKm * biogenicGramsCo2PerKm),
      effectiveEfficiency,
      efficiencyUnit,
      appliedGramsCo2ePerUnit: perUnit.counted,
      scope,
      factor,
      blend,
      assumptions: [...assumptions],
    },
  };
}
