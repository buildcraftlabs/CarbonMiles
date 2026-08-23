import type { ReactNode } from "react";

import { UNKNOWN } from "@/lib/demo/format";

/** A full-width band with a numbered eyebrow, sized to read from the back of a room. */
export function Section({
  eyebrow,
  title,
  lede,
  children,
}: {
  eyebrow: string;
  title: string;
  lede?: string;
  children: ReactNode;
}) {
  return (
    <section className="border-t border-zinc-100/10 py-16 sm:py-20">
      <div className="mx-auto w-full max-w-6xl px-5 sm:px-8">
        <p className="text-[0.75rem] font-semibold tracking-[0.18em] text-emerald-400 uppercase">
          {eyebrow}
        </p>
        <h2 className="mt-3 text-3xl font-semibold tracking-tight text-zinc-50 text-balance sm:text-4xl">
          {title}
        </h2>
        {lede ? (
          <p className="mt-3 max-w-3xl text-base leading-relaxed text-zinc-400 sm:text-lg">
            {lede}
          </p>
        ) : null}
        <div className="mt-10">{children}</div>
      </div>
    </section>
  );
}

/**
 * The rendering of absent data. Deliberately a word, in a muted colour, and
 * never a zero or a dash — the engine reports gaps rather than papering over
 * them, and the interface has to keep that promise.
 */
export function Unknown({ hint }: { hint?: string }) {
  return (
    <span
      className="text-zinc-500 italic"
      title={hint ?? "No data held for this figure."}
    >
      {UNKNOWN}
    </span>
  );
}

export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-2xl border border-zinc-100/10 bg-zinc-100/[0.03] p-5 sm:p-6 ${className}`}
    >
      {children}
    </div>
  );
}

/** A left-anchored proportional bar. `value` and `max` share any unit. */
export function Bar({
  value,
  max,
  className = "bg-emerald-400",
}: {
  value: number;
  max: number;
  className?: string;
}) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-100/10">
      <div className={`h-full rounded-full ${className}`} style={{ width: `${pct}%` }} />
    </div>
  );
}
