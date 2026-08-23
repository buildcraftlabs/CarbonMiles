import { dimensionLabel, joinList, rawFigure } from "@/lib/demo/format";
import type { Contrast } from "@/lib/engine/stage5";

import { Card, Unknown } from "./primitives";

/**
 * Rank 1 against rank 2 — the output that names which dimensions decided the
 * result and, just as importantly, which ones the runner-up actually won.
 *
 * The headline is assembled here from the structured fields rather than from
 * `contrast.summary`: the engine's own sentence carries unrounded floats
 * (`93.38235294117646 g CO2e/km`), which is right for a machine-checkable
 * payload and wrong for a projector.
 */
export function ContrastPanel({ contrast }: { contrast: Contrast }) {
  const maxAbs = Math.max(
    ...contrast.deltas.map((d) => Math.abs(d.contribution)),
    0.01,
  );
  const decided = contrast.decidedBy.map(dimensionLabel);
  const wonOn = contrast.contenderWonOn.map(dimensionLabel);

  return (
    <div className="space-y-6">
      <Card className="border-emerald-400/30 bg-emerald-400/[0.05]">
        <p className="text-xl leading-relaxed text-zinc-100 text-balance sm:text-2xl">
          <span className="font-semibold text-emerald-400">{contrast.winnerName}</span>{" "}
          beats{" "}
          <span className="font-semibold text-zinc-50">{contrast.contenderName}</span>{" "}
          by{" "}
          <span className="font-semibold tabular-nums">
            {contrast.totalScoreGap.toFixed(1)}
          </span>{" "}
          points.
          {decided.length > 0 ? (
            <>
              {" "}
              {joinList(decided)} decided it.
            </>
          ) : null}
          {wonOn.length > 0 ? (
            <>
              {" "}
              The runner-up was genuinely better on{" "}
              <span className="text-amber-300">{joinList(wonOn)}</span>.
            </>
          ) : (
            <> The runner-up did not win a single dimension.</>
          )}
        </p>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2">
        <Column
          heading={`What won it for ${contrast.winnerName}`}
          items={decided}
          tone="emerald"
          empty="No dimension was decisive on its own."
        />
        <Column
          heading={`What ${contrast.contenderName} did better`}
          items={wonOn}
          tone="amber"
          empty="Nothing — it was behind on every dimension."
        />
      </div>

      <Card>
        <h3 className="text-base font-semibold text-zinc-100">
          Every dimension, largest effect first
        </h3>
        <p className="mt-1 text-sm text-zinc-500">
          Bars to the right moved the result toward {contrast.winnerName}; bars to
          the left toward {contrast.contenderName}. Length is{" "}
          <span className="text-zinc-400">score × weight</span>, so a dimension
          matters here only to the extent it was both different and weighted.
        </p>

        <ul className="mt-6 space-y-5">
          {contrast.deltas.map((d) => {
            const pct = (Math.abs(d.contribution) / maxAbs) * 50;
            const toWinner = d.contribution > 0;
            const flat = Math.abs(d.contribution) < 0.005;
            return (
              <li key={d.dimension}>
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <span className="text-base font-medium text-zinc-200">
                    {dimensionLabel(d.dimension)}
                  </span>
                  <span className="text-sm tabular-nums text-zinc-500">
                    {d.winnerRaw === null ? (
                      <Unknown />
                    ) : (
                      rawFigure(d.winnerRaw, d.unit)
                    )}{" "}
                    <span className="text-zinc-600">vs</span>{" "}
                    {d.contenderRaw === null ? (
                      <Unknown />
                    ) : (
                      rawFigure(d.contenderRaw, d.unit)
                    )}
                  </span>
                </div>

                <div className="relative mt-2 h-3 w-full rounded-full bg-zinc-100/[0.06]">
                  <div className="absolute inset-y-0 left-1/2 w-px bg-zinc-100/25" />
                  {!flat && (
                    <div
                      className={`absolute inset-y-0 rounded-full ${
                        toWinner ? "bg-emerald-400" : "bg-amber-400"
                      }`}
                      style={
                        toWinner
                          ? { left: "50%", width: `${pct}%` }
                          : { right: "50%", width: `${pct}%` }
                      }
                    />
                  )}
                </div>

                <p className="mt-1.5 text-xs text-zinc-500">
                  {d.dataGap ? (
                    <span className="text-zinc-400">
                      One side holds no data here, so this is a gap rather than a
                      defeat.
                    </span>
                  ) : flat ? (
                    "Identical on both — did not separate them."
                  ) : (
                    <>
                      {toWinner ? "+" : ""}
                      {d.contribution.toFixed(2)} toward{" "}
                      {toWinner ? contrast.winnerName : contrast.contenderName}
                    </>
                  )}
                </p>
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}

function Column({
  heading,
  items,
  tone,
  empty,
}: {
  heading: string;
  items: string[];
  tone: "emerald" | "amber";
  empty: string;
}) {
  const accent = tone === "emerald" ? "text-emerald-400" : "text-amber-300";
  const dot = tone === "emerald" ? "bg-emerald-400" : "bg-amber-400";
  return (
    <Card>
      <h3 className={`text-sm font-semibold tracking-wide uppercase ${accent}`}>
        {heading}
      </h3>
      {items.length === 0 ? (
        <p className="mt-3 text-base text-zinc-500">{empty}</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {items.map((label) => (
            <li key={label} className="flex items-center gap-3 text-lg text-zinc-100">
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
              {label}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
