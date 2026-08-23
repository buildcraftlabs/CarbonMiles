/**
 * Display formatting for the demo page.
 *
 * Money arrives as paise and is divided only here, at the point of display.
 * Every total was already summed by the engine in integer paise — nothing in
 * this file feeds a number back into a calculation.
 */

import type { ScoreDimension } from "@/lib/engine/stage3";

const INR = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });

/** Paise to a rupee string with separators, e.g. `₹12,52,705`. */
export const rupees = (paise: number) => `₹${INR.format(Math.round(paise / 100))}`;

/** Paise to lakhs, the unit Indian car prices are actually discussed in. */
export const lakh = (paise: number) => `₹${(paise / 10_000_000).toFixed(2)} L`;

/** `costPaisePerKm` is deliberately unrounded by the engine. Round at the view. */
export const perKm = (paisePerKm: number) => `₹${(paisePerKm / 100).toFixed(2)}`;

/** Likewise `gramsCo2ePerKm`. */
export const gramsPerKm = (grams: number) => `${grams.toFixed(1)} g`;

/**
 * The word we use for absent data. Never `0`, never a bare dash — a zero here
 * would read as "this vehicle scored nothing" rather than "we do not know".
 */
export const UNKNOWN = "unknown";

export const DIMENSION_LABELS: Record<ScoreDimension, string> = {
  cost: "Cost to own",
  profitability: "Profitability",
  payback: "Payback",
  usage: "Fits your usage",
  infrastructure: "Refuelling network",
  environment: "CO₂ per km",
  reliability: "Service network",
  resale: "Resale liquidity",
};

export const dimensionLabel = (d: ScoreDimension) => DIMENSION_LABELS[d] ?? d;

/**
 * Format a sub-score's raw figure in its own unit.
 *
 * `unit` comes from the engine (`paise`, `index`, `centres`, `g CO2e/km`), and
 * paise is the only one that needs converting rather than merely rounding.
 */
export function rawFigure(raw: number | null, unit: string): string {
  if (raw === null) return UNKNOWN;
  if (unit === "paise") return lakh(raw);
  if (unit === "g CO2e/km") return `${raw.toFixed(1)} g CO₂e/km`;
  if (unit === "centres") return `${INR.format(raw)} centres`;
  if (unit === "index") return raw.toFixed(1);
  return `${raw.toFixed(1)} ${unit}`;
}

/** Weights are stored to four places; show them as whole percentages. */
export const weightPct = (weight: number) => `${(weight * 100).toFixed(1)}%`;

/**
 * `breakEvenMonthVsTopPick` has three meaningful states and none of them should
 * render as a bare number the audience has to interpret.
 *
 * Note the engine excludes resale from both sides of this comparison: it is
 * realised only on exit, so folding it in would let a vehicle "break even" on
 * money the owner has not yet seen.
 */
export function breakEvenLabel(
  month: number | null | undefined,
  ownershipYears: number,
): string {
  if (month === undefined) return "This is the baseline.";
  if (month === null)
    return `Never catches up within ${ownershipYears} years of ownership.`;
  if (month === 0) return "Costs less than the top pick from day one.";
  if (month < 12) return `Overtakes the top pick at month ${month}.`;
  const yearsPart = Math.floor(month / 12);
  const monthsPart = month % 12;
  const tail = monthsPart === 0 ? "" : ` and ${monthsPart} month${monthsPart === 1 ? "" : "s"}`;
  return `Overtakes the top pick at month ${month} — ${yearsPart} year${yearsPart === 1 ? "" : "s"}${tail} in.`;
}

const FUEL_LABELS: Record<string, string> = {
  petrol: "Petrol",
  diesel: "Diesel",
  cng: "CNG",
  lpg: "LPG",
  electric: "Electric",
  hybrid_mild: "Mild hybrid",
  hybrid_strong: "Strong hybrid",
  plugin_hybrid: "Plug-in hybrid",
  hydrogen: "Hydrogen",
  flex_fuel: "Flex fuel",
};

export const fuelLabel = (f: string) => FUEL_LABELS[f] ?? f;

const SELECTION_LABELS: Record<string, string> = {
  top_pick: "Top pick",
  score: "Earned its place on score",
  fuel_diversity: "Included to show a second powertrain",
};

export const selectionLabel = (s: string) => SELECTION_LABELS[s] ?? s;

/** `hard_filter` / `feasibility_gate` as a human heading. */
export const exclusionStageLabel = (stage: string) =>
  stage === "hard_filter"
    ? "Ruled out by a hard filter"
    : "Ruled out by a feasibility gate";

/** Turn a list of labels into "a, b and c". */
export function joinList(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
