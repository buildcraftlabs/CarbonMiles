import Link from "next/link";

import { ContrastPanel } from "@/components/demo/contrast";
import { MoneyBreakdown } from "@/components/demo/money";
import { Card, Section } from "@/components/demo/primitives";
import { Assumptions, Exclusions } from "@/components/demo/provenance";
import { ScoreBreakdown } from "@/components/demo/scores";
import { Shortlist } from "@/components/demo/shortlist";
import { lakh } from "@/lib/demo/format";
import { runDemo } from "@/lib/demo/run";
import { isCommercial } from "@/lib/engine/profile";

export const metadata = {
  title: "Engine demo · Carbon Miles",
  description:
    "The deterministic recommendation engine, stages 1 to 5, run end to end over illustrative sample data.",
};

/**
 * A plain synchronous Server Component. `runDemo()` is pure, in-memory and
 * hits neither a database nor a model, so it simply runs at render.
 */
export default function DemoPage() {
  const { payload, economicsFailures } = runDemo();
  const { data } = payload;
  const { profile } = data.run;
  const contrast = data.contrast;
  // `passengers` lives on the passenger arm of the profile union only.
  const passengers = isCommercial(profile) ? null : profile.passengers;

  return (
    <main
      data-demo
      className="min-h-screen bg-[#05100c] text-zinc-200 selection:bg-emerald-400/25"
    >
      {/*
        `main` paints the dark ground, but the scroll canvas is painted by
        `html`/`body`, which are light here. Overscrolling — a trackpad
        rubber-band at either end — would flash white behind a dark deck on a
        projector. Same `:has()` guard the landing page uses for `[data-deck]`,
        so it stays scoped to this route rather than leaking into globals.css.
      */}
      <style>{`html:has([data-demo]){background-color:#05100c;}`}</style>

      {/* ── Header + the sample-data label, above the fold and unmissable ── */}
      <header className="mx-auto w-full max-w-6xl px-5 pt-14 pb-4 sm:px-8 sm:pt-20">
        <Link
          href="/"
          className="text-sm text-zinc-500 transition-colors hover:text-emerald-400"
        >
          ← Carbon Miles
        </Link>

        <p className="mt-8 text-[0.75rem] font-semibold tracking-[0.18em] text-emerald-400 uppercase">
          Live engine output
        </p>
        <h1 className="mt-3 text-4xl font-semibold tracking-tight text-zinc-50 text-balance sm:text-6xl">
          The engine decides. Here is it deciding.
        </h1>
        <p className="mt-5 max-w-3xl text-lg leading-relaxed text-zinc-400">
          Stages 1 to 5 of the deterministic recommendation engine, run end to
          end on this request. Hard filters, per-variant economics, weighted
          sub-scores, diversified ranking and the explainability payload — no
          database, no language model, nothing generated.
        </p>

        <div
          role="note"
          className="mt-8 rounded-2xl border border-emerald-400/40 bg-emerald-400/[0.07] p-5 sm:p-6"
        >
          <p className="text-lg leading-relaxed text-zinc-100 text-balance sm:text-xl">
            <span className="font-semibold text-emerald-400">
              Illustrative sample data — the engine is real, the catalogue is not
              yet seeded.
            </span>{" "}
            Every price, efficiency and emission figure below is invented, and
            the vehicle names are deliberately generic. Nothing here describes a
            product you can buy.
          </p>
        </div>

        <dl className="mt-6 flex flex-wrap gap-x-10 gap-y-3 text-sm">
          <Meta label="Engine version" value={data.run.engineVersion} />
          <Meta label="Evaluated as of" value={data.run.asOf} />
          <Meta label="Candidates scored" value={String(data.run.candidateCount)} />
          <Meta label="Shown" value={String(data.run.rankedCount)} />
          <Meta label="Excluded" value={String(data.run.excludedCount)} />
          <Meta label="Omitted" value={String(data.run.omittedCount)} />
        </dl>
      </header>

      {/* ── The question being answered ── */}
      <Section
        eyebrow="The question"
        title="What this buyer asked for"
        lede="The engine takes a structured profile, not a prompt. Every number below is an input it was given, and the run is reproducible from them."
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Fact
            label="Budget, on-road"
            value={`up to ${lakh(profile.budget.maxOnRoadPaise)}`}
          />
          <Fact label="State" value={profile.location.stateCode} />
          <Fact
            label="Driving"
            value={`${profile.usage.dailyKm} km/day`}
            note={`${profile.usage.monthlyKm.toLocaleString("en-IN")} km a month, ${profile.usage.citySharePct}% in the city`}
          />
          <Fact
            label="Ownership horizon"
            value={`${profile.ownershipYears} years`}
            note={
              profile.financing.mode === "loan"
                ? `Loan, ${profile.financing.downPaymentPct}% down over ${profile.financing.tenureMonths} months`
                : "Cash purchase"
            }
          />
          <Fact
            label="Seats needed"
            value={passengers === null ? "Not specified" : String(passengers)}
          />
          <Fact
            label="Typical trip"
            value={`${profile.usage.typicalTripKm} km`}
          />
          <Fact
            label="Home charging"
            value={profile.charging.homeCharging ? "Available" : "Not available"}
            note={
              profile.charging.homeCharging
                ? "So EVs are not range-gated"
                : undefined
            }
          />
          <Fact
            label="Environment preference"
            value={`${Math.round(profile.preferences.environmentWeight * 100)}%`}
            note="Drives how much CO₂ is weighted against money"
          />
        </div>
      </Section>

      {/* ── 1. The ranked shortlist ── */}
      <Section
        eyebrow="Stage 4 · the result"
        title="The shortlist"
        lede="Ranked by weighted total score, then diversified so one model cannot fill the list and a second powertrain always gets a hearing."
      >
        <Shortlist vehicles={data.vehicles} ownershipYears={profile.ownershipYears} />
      </Section>

      {/* ── 2. The contrast — the strongest beat, placed high ── */}
      {contrast ? (
        <Section
          eyebrow="Stage 5 · the contrast"
          title="Why the top pick beat the runner-up"
          lede="Not a list of the winner's strengths — that would be an advert. The engine names the dimensions that decided it and the ones the runner-up genuinely won."
        >
          <ContrastPanel contrast={contrast} />
        </Section>
      ) : null}

      {/* ── 3. Sub-score breakdown ── */}
      <Section
        eyebrow="Stage 3 · the scoring"
        title="How each vehicle scored, dimension by dimension"
        lede="Scores are normalised 0–100 within this shortlist, not on an absolute scale — a 0 means worst of these six, never none at all. The weight is what the profile allowed each dimension to matter, and where a figure is missing the dimension is left unscored and its weight spread across the rest."
      >
        <div className="space-y-5">
          {data.vehicles.map((v) => (
            <ScoreBreakdown key={v.variantId} vehicle={v} />
          ))}
        </div>
      </Section>

      {/* ── 4. The money ── */}
      <Section
        eyebrow="Stage 2 · the economics"
        title="Where the money actually goes"
        lede="Total cost of ownership over the horizon, built from the on-road price, real-world efficiency, the maintenance curve, insurance renewals, loan interest and any battery replacement — with the resale credit discounted to today and netted off."
      >
        <div className="space-y-5">
          {data.vehicles.map((v) => (
            <MoneyBreakdown key={v.variantId} vehicle={v} />
          ))}
        </div>
      </Section>

      {/* ── 5. Exclusions ── */}
      <Section
        eyebrow="Stage 1 · what was ruled out"
        title="We ruled these out, and here is why"
        lede="Exclusions are reported rather than silently applied. Each sentence below is written by the engine itself, and is the same text the interface falls back to when the narration is unavailable."
      >
        <Exclusions
          exclusions={data.exclusions}
          omissions={data.omissions}
          economicsFailures={economicsFailures}
        />
      </Section>

      {/* ── 6. Assumptions and honesty about gaps ── */}
      <Section
        eyebrow="What you can check"
        title="Assumptions, weights and the gaps we know about"
        lede="A recommendation you cannot interrogate is a guess with a decimal point on it."
      >
        <Assumptions
          assumptions={payload.assumptions}
          unattributed={data.unattributed}
          weightBasis={data.weightBasis}
        />
      </Section>

      <footer className="border-t border-zinc-100/10 py-16">
        <div className="mx-auto w-full max-w-6xl px-5 sm:px-8">
          <Card className="border-emerald-400/25 bg-emerald-400/[0.04]">
            <p className="text-base leading-relaxed text-zinc-300">
              <span className="font-semibold text-emerald-400">
                No language model produced anything on this page.
              </span>{" "}
              Every figure, sentence and ranking came from the deterministic
              engine. Narration is layered over this result later, and is
              validated against the payload it was given — a number in the prose
              that is absent from this payload fails the response and falls back
              to the deterministic text you are already reading.
            </p>
            <p className="mt-4 text-sm text-zinc-500">
              Illustrative sample data. Carbon Miles gives advice, not
              certification.
            </p>
          </Card>
        </div>
      </footer>
    </main>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[0.7rem] tracking-wide text-zinc-500 uppercase">{label}</dt>
      <dd className="mt-0.5 font-mono text-sm tabular-nums text-zinc-300">{value}</dd>
    </div>
  );
}

function Fact({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <div className="rounded-xl border border-zinc-100/10 bg-zinc-100/[0.03] p-4">
      <p className="text-[0.7rem] tracking-wide text-zinc-500 uppercase">{label}</p>
      <p className="mt-1.5 text-xl font-semibold text-zinc-100">{value}</p>
      {note ? <p className="mt-1 text-xs leading-snug text-zinc-500">{note}</p> : null}
    </div>
  );
}
