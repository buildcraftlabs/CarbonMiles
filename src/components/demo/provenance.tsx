import { exclusionStageLabel } from "@/lib/demo/format";
import type { Exclusion } from "@/lib/engine/candidate";
import type { Omission } from "@/lib/engine/stage4";
import type { UnattributedNumber } from "@/lib/engine/stage5";
import type { EconomicsFailure } from "@/lib/demo/run";

import { Card } from "./primitives";

/**
 * What did not make the list, and why.
 *
 * The `reason` on every exclusion is a finished sentence written by the engine
 * — it is the deterministic fallback for when the narrative model is
 * unavailable, so it is rendered verbatim rather than reworded here.
 */
export function Exclusions({
  exclusions,
  omissions,
  economicsFailures,
}: {
  exclusions: Exclusion[];
  omissions: Omission[];
  economicsFailures: EconomicsFailure[];
}) {
  const stages = [...new Set(exclusions.map((e) => e.stage))];

  return (
    <div className="space-y-8">
      {stages.map((stage) => (
        <div key={stage}>
          <h3 className="text-sm font-semibold tracking-wide text-zinc-400 uppercase">
            {exclusionStageLabel(stage)}
          </h3>
          <ul className="mt-3 space-y-3">
            {exclusions
              .filter((e) => e.stage === stage)
              .map((e) => (
                <li key={e.variantId}>
                  <Card className="border-zinc-100/[0.08] bg-zinc-100/[0.02]">
                    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                      <span className="text-lg font-medium text-zinc-300">
                        {e.name}
                      </span>
                      <code className="rounded bg-zinc-100/[0.06] px-2 py-0.5 font-mono text-xs text-amber-300">
                        {e.code}
                      </code>
                    </div>
                    <p className="mt-2 text-base text-zinc-400">{e.reason}</p>
                  </Card>
                </li>
              ))}
          </ul>
        </div>
      ))}

      {omissions.length > 0 ? (
        <div>
          <h3 className="text-sm font-semibold tracking-wide text-zinc-400 uppercase">
            Scored, but kept off the list for variety
          </h3>
          <ul className="mt-3 space-y-3">
            {omissions.map((o) => (
              <li key={o.variantId}>
                <Card className="border-zinc-100/[0.08] bg-zinc-100/[0.02]">
                  <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                    <span className="text-lg font-medium text-zinc-300">{o.name}</span>
                    <code className="rounded bg-zinc-100/[0.06] px-2 py-0.5 font-mono text-xs text-sky-300">
                      {o.code}
                    </code>
                  </div>
                  <p className="mt-2 text-base text-zinc-400">{o.reason}</p>
                </Card>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {economicsFailures.length > 0 ? (
        <div>
          <h3 className="text-sm font-semibold tracking-wide text-zinc-400 uppercase">
            Survived filtering but could not be costed
          </h3>
          <ul className="mt-3 space-y-3">
            {economicsFailures.map((f) => (
              <li key={`${f.variantId}-${f.calculation}`}>
                <Card className="border-zinc-100/[0.08] bg-zinc-100/[0.02]">
                  <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                    <span className="text-lg font-medium text-zinc-300">{f.name}</span>
                    <code className="rounded bg-zinc-100/[0.06] px-2 py-0.5 font-mono text-xs text-amber-300">
                      {f.code}
                    </code>
                  </div>
                  <p className="mt-2 text-base text-zinc-400">{f.reason}</p>
                </Card>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The assumptions the run stands on, and the figures it cannot yet attribute.
 *
 * No `provenance` was passed to stage 5, deliberately: every figure in this
 * demo is invented, and attributing invented numbers to invented sources would
 * defeat the point of having a provenance rule. The engine notices and says so
 * itself — the count below is its own report, not a disclaimer bolted on after.
 */
export function Assumptions({
  assumptions,
  unattributed,
  weightBasis,
}: {
  assumptions: string[];
  unattributed: UnattributedNumber[];
  weightBasis: string[];
}) {
  const fields = [
    ...new Set(
      unattributed.map((u) =>
        u.entityTable && u.field ? `${u.entityTable}.${u.field}` : u.key,
      ),
    ),
  ].sort();

  return (
    // `min-w-0` on the items: grid children default to `min-width: auto`, and
    // the unbroken `table.column` names below would otherwise push the track
    // wider than the viewport.
    <div className="grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
      <Card>
        <h3 className="text-sm font-semibold tracking-wide text-emerald-400 uppercase">
          How the weights were chosen
        </h3>
        <ul className="mt-4 space-y-3">
          {weightBasis.map((b) => (
            <li key={b} className="text-base leading-relaxed text-zinc-300">
              {b}
            </li>
          ))}
        </ul>

        <h3 className="mt-8 text-sm font-semibold tracking-wide text-amber-300 uppercase">
          Figures not yet traced to a source
        </h3>
        <p className="mt-3 text-base leading-relaxed text-zinc-300">
          <span className="text-2xl font-semibold tabular-nums text-amber-300">
            {unattributed.length}
          </span>{" "}
          numbers in this result carry no provenance record, across{" "}
          {fields.length} distinct fields. The engine reports this itself rather
          than letting an unattributed number reach you unmarked.
        </p>
        <ul className="mt-3 flex flex-wrap gap-2">
          {fields.map((f) => (
            <li
              key={f}
              className="rounded bg-zinc-100/[0.06] px-2 py-1 font-mono text-xs break-all text-zinc-500"
            >
              {f}
            </li>
          ))}
        </ul>
      </Card>

      <Card>
        <h3 className="text-sm font-semibold tracking-wide text-emerald-400 uppercase">
          Every assumption this run made
        </h3>
        <p className="mt-1 text-sm text-zinc-500">
          {assumptions.length} statements, verbatim from the engine.
        </p>
        <ul className="mt-4 max-h-[32rem] space-y-2.5 overflow-y-auto pr-2">
          {assumptions.map((a, i) => (
            <li
              key={`${i}-${a.slice(0, 24)}`}
              className="flex gap-3 text-sm leading-relaxed text-zinc-400"
            >
              <span className="shrink-0 tabular-nums text-zinc-600">
                {String(i + 1).padStart(2, "0")}
              </span>
              {a}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
