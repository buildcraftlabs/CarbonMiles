import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

type FoldProps = {
  /** Used for the section id and the heading id it is labelled by. */
  id: string;
  /** Small label above the heading. */
  eyebrow: string;
  title: ReactNode;
  /** One sentence. If it needs two, it belongs in the figure caption. */
  lede?: ReactNode;
  /** The illustration. Sits beside the copy from `lg` up, under it below. */
  figure?: ReactNode;
  children?: ReactNode;
  /** Only the first fold should be an h1. */
  heading?: "h1" | "h2";
  /** 1-based position, for the corner counter. */
  index: number;
  total: number;
  className?: string;
};

/**
 * One full-viewport fold. A real <section> with a real heading, so the deck is
 * an ordinary document to a screen reader and to a keyboard, whatever the
 * scroll-snap layer is doing.
 */
export function Fold({
  id,
  eyebrow,
  title,
  lede,
  figure,
  children,
  heading = "h2",
  index,
  total,
  className,
}: FoldProps) {
  const Heading = heading;

  return (
    <section
      id={id}
      tabIndex={-1}
      aria-labelledby={`${id}-title`}
      className={className}
    >
      <div
        className={cn(
          "mx-auto flex w-full max-w-6xl flex-1 flex-col justify-center gap-7 px-5 py-10 sm:px-10 sm:py-16 lg:py-20",
          figure &&
            "lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:items-center lg:gap-12 xl:gap-16",
        )}
      >
        <div className="flex flex-col gap-3 sm:gap-5">
          <p className="text-[0.68rem] font-medium tracking-[0.22em] text-emerald-400/80 uppercase sm:text-[0.7rem]">
            {eyebrow}
          </p>

          <Heading
            id={`${id}-title`}
            className={cn(
              "max-w-xl text-balance font-semibold tracking-tight text-zinc-50",
              heading === "h1"
                ? "text-[1.75rem] leading-[1.12] sm:text-5xl lg:text-6xl"
                : "text-[1.4rem] leading-[1.18] sm:text-3xl lg:text-[2.6rem] lg:leading-[1.12]",
            )}
          >
            {title}
          </Heading>

          {lede ? (
            <p className="max-w-lg text-pretty text-sm leading-relaxed text-zinc-400 sm:text-base">
              {lede}
            </p>
          ) : null}

          {children}
        </div>

        {figure ? <div className="w-full">{figure}</div> : null}
      </div>

      <p
        aria-hidden="true"
        className="pointer-events-none absolute right-5 bottom-4 font-mono text-[0.7rem] tabular-nums text-zinc-700 sm:right-8 sm:bottom-8"
      >
        {String(index).padStart(2, "0")} / {String(total).padStart(2, "0")}
      </p>
    </section>
  );
}
