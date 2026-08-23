import { lakh, perKm, rupees } from "@/lib/demo/format";
import type { ExplainedVehicle } from "@/lib/engine/stage5";

import { Card } from "./primitives";

/** The cost legs, in the order they are stacked. */
const LEGS = [
  { key: "acquisitionPaise", label: "Acquisition", colour: "bg-emerald-400" },
  { key: "energyPaise", label: "Fuel or charging", colour: "bg-emerald-500" },
  { key: "maintenancePaise", label: "Maintenance", colour: "bg-teal-500" },
  { key: "insuranceRenewalPaise", label: "Insurance renewals", colour: "bg-cyan-600" },
  { key: "financingInterestPaise", label: "Loan interest", colour: "bg-sky-700" },
  { key: "batteryReplacementPaise", label: "Battery replacement", colour: "bg-indigo-600" },
] as const;

/**
 * Where the money goes over the ownership horizon.
 *
 * `totalPaise` already has the resale credit netted off, so the stacked legs
 * sum to more than the total — the credit is shown separately below the bar
 * rather than as a negative segment, which would misread as a cost.
 */
export function MoneyBreakdown({ vehicle }: { vehicle: ExplainedVehicle }) {
  const t = vehicle.tco;
  const gross = LEGS.reduce((sum, leg) => sum + t[leg.key], 0);
  const legs = LEGS.filter((leg) => t[leg.key] > 0);

  return (
    <Card className={vehicle.rank === 1 ? "border-emerald-400/30" : undefined}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <h3 className="text-xl font-semibold text-zinc-50">
          <span className="text-zinc-500 tabular-nums">#{vehicle.rank}</span>{" "}
          {vehicle.name}
        </h3>
        <div className="flex items-baseline gap-6">
          <div className="text-right">
            <p className="text-3xl font-semibold tabular-nums text-emerald-400">
              {lakh(t.totalPaise)}
            </p>
            <p className="text-[0.7rem] tracking-wide text-zinc-500 uppercase">
              over {t.ownershipYears} years
            </p>
          </div>
          <div className="text-right">
            <p className="text-3xl font-semibold tabular-nums text-zinc-100">
              {perKm(t.costPaisePerKm)}
            </p>
            <p className="text-[0.7rem] tracking-wide text-zinc-500 uppercase">
              per km
            </p>
          </div>
        </div>
      </div>

      {/* Stacked gross spend */}
      <div className="mt-6 flex h-4 w-full overflow-hidden rounded-full bg-zinc-100/[0.06]">
        {legs.map((leg) => (
          <div
            key={leg.key}
            className={leg.colour}
            style={{ width: `${(t[leg.key] / gross) * 100}%` }}
            title={`${leg.label}: ${rupees(t[leg.key])}`}
          />
        ))}
      </div>

      <ul className="mt-5 grid gap-x-6 gap-y-2 sm:grid-cols-2">
        {legs.map((leg) => (
          <li key={leg.key} className="flex items-center gap-3 text-sm">
            <span className={`h-2.5 w-2.5 shrink-0 rounded-sm ${leg.colour}`} />
            <span className="flex-1 text-zinc-300">{leg.label}</span>
            <span className="tabular-nums text-zinc-400">{rupees(t[leg.key])}</span>
          </li>
        ))}
      </ul>

      <dl className="mt-5 space-y-1.5 border-t border-zinc-100/10 pt-4 text-sm">
        <div className="flex justify-between gap-4">
          <dt className="text-zinc-400">Gross spend before resale</dt>
          <dd className="tabular-nums text-zinc-300">{rupees(gross)}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-zinc-400">
            Resale credit, discounted to today
            <span className="ml-2 text-xs text-zinc-600">
              (face value {rupees(t.resaleNominalPaise)})
            </span>
          </dt>
          <dd className="tabular-nums text-emerald-400">
            −{rupees(t.resaleCreditPaise)}
          </dd>
        </div>
        <div className="flex justify-between gap-4 border-t border-zinc-100/10 pt-2 text-base font-semibold">
          <dt className="text-zinc-200">Total cost to own</dt>
          <dd className="tabular-nums text-zinc-50">{rupees(t.totalPaise)}</dd>
        </div>
      </dl>

      <p className="mt-3 text-xs text-zinc-500">
        {t.totalKm.toLocaleString("en-IN")} km over {t.ownershipYears} years, at
        the real-world efficiency figure — never the claimed one.
      </p>
    </Card>
  );
}
