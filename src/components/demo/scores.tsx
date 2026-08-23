import {
  dimensionLabel,
  fuelLabel,
  rawFigure,
  weightPct,
} from "@/lib/demo/format";
import type { ExplainedVehicle } from "@/lib/engine/stage5";

import { Card, Unknown } from "./primitives";

/**
 * Per-vehicle sub-score breakdown: the dimension, the score, the weight it was
 * given, and the raw figure the score was derived from.
 *
 * Scores are normalised 0–100 *within this candidate set*, not on an absolute
 * scale — so a 0 means "worst of these six", not "none at all". The range is
 * printed beside every score to make that explicit.
 */
export function ScoreBreakdown({ vehicle }: { vehicle: ExplainedVehicle }) {
  return (
    <Card className={vehicle.rank === 1 ? "border-emerald-400/30" : undefined}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="text-xl font-semibold text-zinc-50">
          <span className="text-zinc-500 tabular-nums">#{vehicle.rank}</span>{" "}
          {vehicle.name}
        </h3>
        <p className="text-sm text-zinc-500">
          {fuelLabel(vehicle.fuelType)} · total{" "}
          <span className="tabular-nums text-zinc-300">
            {vehicle.totalScore.toFixed(1)}
          </span>
        </p>
      </div>

      <ul className="mt-6 space-y-5">
        {vehicle.subScores.map((s) => {
          const unknown = s.score === null;
          return (
            <li key={s.dimension} className="grid gap-2 sm:grid-cols-[13rem_1fr]">
              <div>
                <p className="text-base font-medium text-zinc-200">
                  {dimensionLabel(s.dimension)}
                </p>
                <p className="text-xs text-zinc-500">
                  {s.weight === 0 ? (
                    "weight redistributed"
                  ) : (
                    <>weight {weightPct(s.weight)}</>
                  )}
                </p>
              </div>

              <div>
                <div className="flex flex-wrap items-baseline justify-between gap-x-4">
                  <span className="text-2xl font-semibold tabular-nums text-zinc-100">
                    {s.score === null ? (
                      <Unknown hint={reasonFor(vehicle, s.dimension)} />
                    ) : (
                      s.score.toFixed(0)
                    )}
                  </span>
                  <span className="text-sm tabular-nums text-zinc-400">
                    {rawFigure(s.raw, s.unit)}
                  </span>
                </div>

                {/* The bar is the score, so it agrees with the number directly
                    above it. The weight is printed as text beside the dimension
                    name; encoding weight here instead made a 0 sit under a
                    nearly-full bar, which reads as the opposite of the truth. */}
                <div className="relative mt-2 h-1.5 w-full overflow-hidden rounded-full bg-zinc-100/[0.06]">
                  {s.score === null ? null : (
                    <div
                      className="h-full rounded-full bg-emerald-400/70"
                      style={{ width: `${Math.max(0, Math.min(100, s.score))}%` }}
                    />
                  )}
                </div>

                <p className="mt-1.5 text-xs text-zinc-500">
                  {unknown ? (
                    <span className="text-zinc-400">
                      {reasonFor(vehicle, s.dimension) ??
                        "No value held, so this dimension was left unscored and its weight spread across the rest."}
                    </span>
                  ) : !s.discriminating ? (
                    "Every candidate tied here — did not separate them."
                  ) : s.range ? (
                    <>
                      measured against {rawFigure(s.range.min, s.unit)} –{" "}
                      {rawFigure(s.range.max, s.unit)} across this shortlist,{" "}
                      {s.direction === "lower_is_better"
                        ? "lower is better"
                        : "higher is better"}
                    </>
                  ) : null}
                  {/* On an unscored dimension the engine's `note` restates the
                      reason we have already printed, so it is dropped. */}
                  {s.note && !unknown ? (
                    <span className="text-zinc-600"> · {s.note}</span>
                  ) : null}
                </p>
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

/** The engine's own sentence for why a dimension could not be scored. */
function reasonFor(vehicle: ExplainedVehicle, dimension: string): string | undefined {
  return vehicle.unscored.find((u) => u.dimension === dimension)?.reason;
}
