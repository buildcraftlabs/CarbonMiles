import {
  breakEvenLabel,
  fuelLabel,
  lakh,
  perKm,
  selectionLabel,
} from "@/lib/demo/format";
import type { ExplainedVehicle } from "@/lib/engine/stage5";

import { Bar, Card, Unknown } from "./primitives";

/** The ranked result, best first. Rank 1 is visually distinct from the rest. */
export function Shortlist({
  vehicles,
  ownershipYears,
}: {
  vehicles: ExplainedVehicle[];
  ownershipYears: number;
}) {
  return (
    <ol className="space-y-4">
      {vehicles.map((v) => {
        const top = v.rank === 1;
        return (
          <li key={v.variantId}>
            <Card
              className={
                top
                  ? "border-emerald-400/40 bg-emerald-400/[0.06]"
                  : undefined
              }
            >
              <div className="flex flex-wrap items-baseline gap-x-5 gap-y-2">
                <span
                  className={`text-2xl font-semibold tabular-nums ${
                    top ? "text-emerald-400" : "text-zinc-500"
                  }`}
                >
                  #{v.rank}
                </span>

                <div className="min-w-0 flex-1">
                  <h3 className="text-xl font-semibold text-zinc-50 sm:text-2xl">
                    {v.name}
                  </h3>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Badge>{fuelLabel(v.fuelType)}</Badge>
                    <Badge accent={top}>{selectionLabel(v.selectedBy)}</Badge>
                    {v.bestInFuel ? (
                      <Badge>Best {fuelLabel(v.fuelType).toLowerCase()} in the pool</Badge>
                    ) : null}
                  </div>
                </div>

                <div className="text-right">
                  <p
                    className={`text-5xl leading-none font-semibold tabular-nums ${
                      top ? "text-emerald-400" : "text-zinc-100"
                    }`}
                  >
                    {v.totalScore.toFixed(1)}
                  </p>
                  <p className="mt-1 text-[0.7rem] tracking-wide text-zinc-500 uppercase">
                    of 100
                  </p>
                </div>
              </div>

              <div className="mt-5">
                <Bar
                  value={v.totalScore}
                  max={100}
                  className={top ? "bg-emerald-400" : "bg-zinc-400/50"}
                />
              </div>

              <dl className="mt-5 grid gap-4 border-t border-zinc-100/10 pt-4 sm:grid-cols-3">
                <Stat label={`${ownershipYears}-year cost to own`} value={lakh(v.tco.totalPaise)} />
                <Stat label="Cost per kilometre" value={perKm(v.tco.costPaisePerKm)} />
                <Stat
                  label="CO₂ per kilometre"
                  value={
                    v.co2 ? (
                      `${v.co2.gramsCo2ePerKm.toFixed(1)} g`
                    ) : (
                      <Unknown hint="No emission factor matched this vehicle's fuel and efficiency unit." />
                    )
                  }
                />
              </dl>

              <p className="mt-4 text-sm text-zinc-400">
                {breakEvenLabel(v.breakEvenMonthVsTopPick, ownershipYears)}
              </p>
            </Card>
          </li>
        );
      })}
    </ol>
  );
}

function Stat({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div>
      <dt className="text-[0.7rem] tracking-wide text-zinc-500 uppercase">{label}</dt>
      <dd className="mt-1 text-xl font-semibold tabular-nums text-zinc-100">{value}</dd>
    </div>
  );
}

function Badge({
  children,
  accent = false,
}: {
  children: React.ReactNode;
  accent?: boolean;
}) {
  return (
    <span
      className={`rounded-full px-2.5 py-1 text-[0.7rem] font-medium ${
        accent
          ? "bg-emerald-400/15 text-emerald-300"
          : "bg-zinc-100/[0.06] text-zinc-400"
      }`}
    >
      {children}
    </span>
  );
}
