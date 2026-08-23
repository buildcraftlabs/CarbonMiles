import Link from "next/link";

import {
  AdvisorFlow,
  E20Verdict,
  EngineBoundary,
  FivePowertrains,
  IconFirstCar,
  IconFleet,
  IconPump,
  IconUpgrade,
  Provenance,
  TwoJourneys,
} from "@/components/deck/art";
import { DeckController } from "@/components/deck/deck-controller";
import { Fold } from "@/components/deck/fold";

const TOTAL = 8;

const PEOPLE = [
  {
    icon: <IconFirstCar />,
    who: "First-car buyer",
    what: "A shortlist that survives year four.",
  },
  {
    icon: <IconUpgrade />,
    who: "Upgrade buyer",
    what: "Whether the switch pays back, and when.",
  },
  {
    icon: <IconFleet />,
    who: "Fleet or commercial",
    what: "₹/km, payback month, ROI.",
  },
  {
    icon: <IconPump />,
    who: "Petrol owner",
    what: "A straight E20 answer.",
  },
];

export default function Home() {
  return (
    <>
      <main
        id="deck"
        data-deck=""
        className="w-full bg-[#05100c] text-zinc-200 selection:bg-emerald-400/25"
      >
        {/* 1 ─ Hero */}
        <Fold
          id="fold-intro"
          index={1}
          total={TOTAL}
          heading="h1"
          eyebrow="Carbon Miles"
          title={
            <>
              Know what a vehicle{" "}
              <span className="text-emerald-400">actually</span> costs.
            </>
          }
          lede="Mobility intelligence for India. Two advisors, one curated database, arithmetic you can check."
          figure={
            <TwoJourneys caption="Two questions. One engine underneath both." />
          }
        >
          <p className="mt-1 flex items-center gap-3 text-[0.7rem] tracking-wide text-zinc-500 uppercase">
            <span
              aria-hidden="true"
              className="inline-block h-7 w-px bg-gradient-to-b from-emerald-400/70 to-transparent"
            />
            Scroll, or press the down arrow
          </p>
        </Fold>

        {/* 2 ─ The problem */}
        <Fold
          id="fold-problem"
          index={2}
          total={TOTAL}
          eyebrow="The problem"
          title="Five powertrains. One right answer. No way to tell."
          lede="A spec sheet is true but useless. A review is readable but not about you."
          figure={
            <FivePowertrains caption="Which ray wins turns on your state's road tax, your electricity tariff, the pumps on your route, and what a battery costs in year eight." />
          }
        />

        {/* 3 ─ Journey A */}
        <Fold
          id="fold-advisor"
          index={3}
          total={TOTAL}
          eyebrow="Journey A"
          title="Vehicle Purchase Advisor"
          lede="Describe how you drive. Get a shortlist, what each one costs to own, and why the top result won."
          figure={
            <AdvisorFlow caption="Passenger and commercial, hatchback to heavy. Commercial results add margin, payback month and ROI." />
          }
        />

        {/* 4 ─ Journey B */}
        <Fold
          id="fold-e20"
          index={4}
          total={TOTAL}
          eyebrow="Journey B"
          title="E20 Compatibility Advisor"
          lede="Pick the vehicle you already own. Get a straight answer about the petrol you cannot avoid buying."
          figure={
            <E20Verdict caption="Verdict scoped to your variant and year, with the material risks named and every piece of guidance traced to its source." />
          }
        />

        {/* 5 ─ How it works */}
        <Fold
          id="fold-engine"
          index={5}
          total={TOTAL}
          eyebrow="How it works"
          title="The engine decides. The model only speaks."
          lede="No live web search at conversation time — so a result is reproducible, and can be argued with."
          figure={
            <EngineBoundary caption="The deterministic result renders first and stands on its own. The narration streams over it, and is checked against the payload it was given." />
          }
        />

        {/* 6 ─ Provenance */}
        <Fold
          id="fold-principles"
          index={6}
          total={TOTAL}
          eyebrow="What you can check"
          title="Every number shows its working."
          lede="A recommendation you cannot interrogate is a guess with a decimal point on it."
          figure={
            <Provenance caption="Calculations run on real-world efficiency, never on claimed figures. Where there is no data, the verdict is unknown and the interface says so." />
          }
        />

        {/* 7 ─ Who it is for */}
        <Fold
          id="fold-people"
          index={7}
          total={TOTAL}
          eyebrow="Who it is for"
          title="Four people. Four different questions."
          figure={
            <ul className="grid gap-3 sm:grid-cols-2 lg:gap-4">
              {PEOPLE.map(({ icon, who, what }) => (
                <li
                  key={who}
                  className="flex items-start gap-3 rounded-xl border border-zinc-100/10 bg-zinc-100/[0.03] p-3.5 sm:p-4"
                >
                  {icon}
                  <div>
                    <p className="text-[0.85rem] font-semibold text-zinc-100">
                      {who}
                    </p>
                    <p className="mt-0.5 text-[0.8rem] leading-snug text-zinc-400">
                      {what}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          }
        />

        {/* 8 ─ Call to action */}
        <Fold
          id="fold-start"
          index={8}
          total={TOTAL}
          eyebrow="Start"
          title="Ask it the question you actually have."
          lede="The deterministic engine is built and tested. The advisors are being wired onto it now."
        >
          <div className="mt-2 flex flex-col items-start gap-4">
            <Link
              href="/login"
              className="inline-flex h-12 items-center justify-center rounded-full bg-emerald-400 px-8 text-base font-semibold text-[#05100c] transition-colors hover:bg-emerald-300 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-300"
            >
              Try now
            </Link>
            <p className="text-[0.8rem] text-zinc-500">
              Built for phone, tablet and desktop.
            </p>
          </div>

          <p className="mt-8 max-w-md border-t border-zinc-100/10 pt-5 text-[0.7rem] leading-relaxed text-zinc-600">
            Prices and running costs are modelled, dated and labelled as such.
            Carbon Miles gives advice, not certification.
          </p>
        </Fold>
      </main>

      <DeckController total={TOTAL} />
    </>
  );
}
