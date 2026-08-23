import type { CandidateVariant } from "./candidate";
import type { FuelType } from "./enums";
import type { ScoredCandidate, ScoringInput } from "./stage3";

/**
 * Stage 4 — diversification and final ranking (FR-A8).
 *
 * Stage 3 leaves the candidates in input order carrying a score each. Sorting
 * them and taking the top five would be one line, and it would produce a bad
 * result set: variants of the same model differ from each other by a sunroof
 * and score within a point of each other, so an unconstrained top five is
 * routinely the same car five times. A buyer learns nothing from that.
 *
 * So two constraints are applied on top of the ordering:
 *
 *   - **At most `MAX_VARIANTS_PER_MODEL` variants of any one model.** One model
 *     cannot flood the list.
 *   - **At least `MIN_DISTINCT_FUELS` distinct fuel types, where the candidate
 *     pool actually contains them.** The whole product is a claim about which
 *     powertrain suits a buyer; answering with five petrol hatchbacks when a
 *     feasible EV was two points behind hides the decision the user came to
 *     make.
 *
 * Both constraints cost score, and neither is allowed to cost the *top pick*.
 * The highest-scoring candidate is always rank 1. Diversification rearranges
 * what sits behind it, never what wins.
 *
 * Everything removed is reported with a reason, same doctrine as stage 1: a
 * result set that quietly dropped a better-scoring vehicle is not explainable,
 * and FR-A9 requires that it be.
 *
 * No database access, no clock, no LLM. Deterministic down to the tie-break,
 * so a stored run replays to the same list (FR-A12).
 */

/**
 * A model may appear twice — typically the sensible trim and the one a rung
 * up. A third adds a price point, not a decision. Exported as data so the
 * payload can cite the cap that removed a vehicle.
 */
export const MAX_VARIANTS_PER_MODEL = 2;

/** Below two powertrains the list stops being an answer to "which powertrain".
 * Enforced only when the pool holds a second one — inventing diversity that
 * survived no gate would be worse than admitting there is one sensible fuel. */
export const MIN_DISTINCT_FUELS = 2;

/** The PRD promises 3–5 vehicles. Five is the ceiling; the floor is however
 * many survived, because padding a short list means recommending something the
 * filters had already judged unsuitable. */
export const DEFAULT_RESULT_LIMIT = 5;

export type SelectionReason =
  /** Highest score in the whole set. Always rank 1, never displaced. */
  | "top_pick"
  /** Earned its place on score alone. */
  | "score"
  /** Promoted over a higher-scoring vehicle to put a second powertrain in the
   * list. */
  | "fuel_diversity";

export type OmissionCode =
  /** Two variants of its model were already in the list. */
  | "model_cap"
  /** In the list until a second fuel type had to be found room for. */
  | "displaced_for_fuel_diversity"
  /** Simply outscored — the ordinary reason. */
  | "outscored";

export interface RankedCandidate {
  /** 1-based, and 1 is always the highest score in the set. */
  rank: number;
  variantId: string;
  modelId: string;
  name: string;
  fuelType: FuelType;
  totalScore: number;
  selectedBy: SelectionReason;
  /** The best-scoring candidate of its fuel type across the whole pool, not
   * merely the best of that fuel in the final list. */
  bestInFuel: boolean;
}

export interface Omission {
  variantId: string;
  name: string;
  code: OmissionCode;
  reason: string;
}

export interface Stage4Input {
  /**
   * The same array stage 3 was given, in the same order. Stage 3 maps over its
   * input, so `scored[i]` describes `candidates[i]`; the pairing is checked
   * rather than trusted, because a misaligned pair would rank one vehicle
   * under another's name.
   */
  candidates: readonly ScoringInput[];
  scored: readonly ScoredCandidate[];
  /** Defaults to `DEFAULT_RESULT_LIMIT`. */
  limit?: number;
}

export type Stage4Result =
  | {
      ok: true;
      ranked: RankedCandidate[];
      omitted: Omission[];
      assumptions: string[];
    }
  | { ok: false; code: "candidates_misaligned"; reason: string };

interface Entry {
  variant: CandidateVariant;
  scored: ScoredCandidate;
}

/**
 * Highest score first, ties broken on `variantId`.
 *
 * The tie-break is arbitrary and that is the point: it has to be *stable*, or
 * a stored run replays into a different order than the one the user was shown
 * and FR-A12 stops holding. Sorting on a name would reorder the moment a
 * catalogue edit fixed a typo.
 */
const byScoreThenId = (a: Entry, b: Entry): number =>
  b.scored.totalScore - a.scored.totalScore ||
  (a.variant.variantId < b.variant.variantId ? -1 : 1);

/**
 * Stage 4 end to end.
 *
 * Greedy under the model cap, then one corrective swap for fuel diversity. The
 * swap is a swap and not a re-run because the alternative — re-solving the
 * whole selection under a diversity constraint — changes the top of the list
 * to fix the bottom of it, and the top of the list is the answer.
 */
export function runStage4(input: Stage4Input): Stage4Result {
  const { candidates, scored } = input;
  const limit = input.limit ?? DEFAULT_RESULT_LIMIT;

  if (candidates.length !== scored.length) {
    return {
      ok: false,
      code: "candidates_misaligned",
      reason: `Given ${candidates.length} candidates and ${scored.length} scores. They must be the same array, in the same order.`,
    };
  }

  const entries: Entry[] = [];
  for (const [index, entry] of candidates.entries()) {
    const score = scored[index];
    if (score.variantId !== entry.variant.variantId) {
      return {
        ok: false,
        code: "candidates_misaligned",
        reason: `Position ${index} scores ${score.variantId} but the candidate there is ${entry.variant.variantId}.`,
      };
    }
    entries.push({ variant: entry.variant, scored: score });
  }

  const assumptions: string[] = [];
  if (entries.length === 0) {
    return { ok: true, ranked: [], omitted: [], assumptions };
  }

  const ordered = [...entries].sort(byScoreThenId);

  /** Best scorer of each fuel type across the whole pool, for `bestInFuel`. */
  const bestByFuel = new Map<FuelType, string>();
  for (const entry of ordered) {
    if (!bestByFuel.has(entry.variant.fuelType)) {
      bestByFuel.set(entry.variant.fuelType, entry.variant.variantId);
    }
  }

  const omitted: Omission[] = [];
  const selected: Entry[] = [];
  const perModel = new Map<string, number>();

  for (const entry of ordered) {
    if (selected.length >= limit) break;
    const used = perModel.get(entry.variant.modelId) ?? 0;
    if (used >= MAX_VARIANTS_PER_MODEL) {
      omitted.push({
        variantId: entry.variant.variantId,
        name: entry.variant.name,
        code: "model_cap",
        reason: `Two variants of this model are already in your results, and a third would crowd out a different vehicle.`,
      });
      continue;
    }
    perModel.set(entry.variant.modelId, used + 1);
    selected.push(entry);
  }

  /**
   * Fuel diversity. Only ever acts when the pool holds a fuel the list does
   * not, and only ever displaces the *last* selected vehicle — never the top
   * pick, and never a vehicle that is itself carrying a fuel type nothing else
   * in the list has.
   */
  const selectedIds = new Set(selected.map((e) => e.variant.variantId));
  const fuelsInList = new Set(selected.map((e) => e.variant.fuelType));
  let promotedId: string | undefined;

  if (fuelsInList.size < MIN_DISTINCT_FUELS && selected.length > 1) {
    const alternative = ordered.find(
      (entry) =>
        !selectedIds.has(entry.variant.variantId) &&
        !fuelsInList.has(entry.variant.fuelType),
    );

    if (alternative !== undefined) {
      const displaced = selected.pop();
      if (displaced !== undefined) {
        perModel.set(
          displaced.variant.modelId,
          (perModel.get(displaced.variant.modelId) ?? 1) - 1,
        );
        omitted.push({
          variantId: displaced.variant.variantId,
          name: displaced.variant.name,
          code: "displaced_for_fuel_diversity",
          reason: `Scored well, but every other result already ran on ${displaced.variant.fuelType}. Its place went to a ${alternative.variant.fuelType} vehicle so you can see the comparison.`,
        });
      }

      selected.push(alternative);
      selectedIds.add(alternative.variant.variantId);
      promotedId = alternative.variant.variantId;
      perModel.set(
        alternative.variant.modelId,
        (perModel.get(alternative.variant.modelId) ?? 0) + 1,
      );
      assumptions.push(
        `Only ${alternative.variant.fuelType} and ${[...fuelsInList].join(", ")} vehicles remained after the filters, so one ${alternative.variant.fuelType} option was promoted into the list ahead of a higher-scoring one to keep the comparison honest.`,
      );

      /** The model cap can only have been relaxed by the removal, so nothing
       * needs re-checking — but the promoted vehicle may outscore what is
       * above it, so the list is re-ordered before ranks are assigned. */
      selected.sort(byScoreThenId);
    } else if (entries.length > selected.length) {
      assumptions.push(
        `Every vehicle that survived the filters runs on ${[...fuelsInList].join(", ")}, so there is no second powertrain to compare against.`,
      );
    }
  }

  const topId = ordered[0].variant.variantId;
  const ranked: RankedCandidate[] = selected.map((entry, index) => ({
    rank: index + 1,
    variantId: entry.variant.variantId,
    modelId: entry.variant.modelId,
    name: entry.variant.name,
    fuelType: entry.variant.fuelType,
    totalScore: entry.scored.totalScore,
    selectedBy:
      entry.variant.variantId === topId
        ? "top_pick"
        : entry.variant.variantId === promotedId
          ? "fuel_diversity"
          : "score",
    bestInFuel: bestByFuel.get(entry.variant.fuelType) === entry.variant.variantId,
  }));

  /** Everything else was simply outscored. Reported so the result set can
   * account for every candidate that reached this stage, not just the ones it
   * had a special reason to drop. */
  const accountedFor = new Set([
    ...ranked.map((r) => r.variantId),
    ...omitted.map((o) => o.variantId),
  ]);
  for (const entry of ordered) {
    if (accountedFor.has(entry.variant.variantId)) continue;
    omitted.push({
      variantId: entry.variant.variantId,
      name: entry.variant.name,
      code: "outscored",
      reason: `Scored ${entry.scored.totalScore} against ${ranked[ranked.length - 1]?.totalScore ?? 0} for the last vehicle shown.`,
    });
  }

  if (ranked.length < 3 && entries.length >= 3) {
    assumptions.push(
      "Fewer than three vehicles are shown because the model cap left nothing else to show.",
    );
  }

  return { ok: true, ranked, omitted, assumptions };
}
