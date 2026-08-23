"use client";

import { useEffect, useState } from "react";

const EDITABLE =
  "input, textarea, select, [contenteditable=''], [contenteditable='true']";
const ACTIVATABLE = "button, summary, [role='button'], [role='menuitem']";

function foldsOf(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(":scope > section"));
}

/** The fold whose top edge is nearest the top of the viewport. */
function currentIndex(folds: HTMLElement[]): number {
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;

  folds.forEach((fold, i) => {
    const distance = Math.abs(fold.getBoundingClientRect().top);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  });

  return best;
}

/**
 * Keyboard advancing and a progress read-out for the deck.
 *
 * Scroll and trackpad advancing is CSS `scroll-snap` — nothing here touches the
 * wheel. This only exists because with `scroll-snap-type: y mandatory` a native
 * arrow-key nudge is too small to leave the current snap point and gets pulled
 * back, so the arrow keys need an explicit target.
 *
 * Under `prefers-reduced-motion: reduce` the handler bows out entirely and the
 * browser's own scrolling takes every key, which is what the CSS is set up for.
 */
export function DeckController({ total }: { total: number }) {
  const [active, setActive] = useState(0);

  useEffect(() => {
    const root = document.getElementById("deck");
    if (!root) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

    // A fold taller than the viewport cannot be held between two mandatory
    // snap points without stranding its overflow, so measure and tell the
    // stylesheet which regime to use. Small phones and landscape phones are
    // the cases that hit this.
    const syncFit = () => {
      const overflowing = foldsOf(root).some(
        (fold) => fold.scrollHeight > window.innerHeight + 1,
      );
      document.documentElement.dataset.deckFit = overflowing
        ? "overflow"
        : "fits";
    };

    let frame = 0;
    const syncActive = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        setActive(currentIndex(foldsOf(root)));
      });
    };

    const goTo = (fold: HTMLElement) => {
      // Move focus first so the next key press is still handled here and a
      // screen reader announces the fold it just landed on. preventScroll keeps
      // focus from doing an unanimated jump of its own.
      fold.focus({ preventScroll: true });
      fold.scrollIntoView({ behavior: "smooth", block: "start" });
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (reduced.matches) return;
      if (event.defaultPrevented) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const target = event.target as HTMLElement | null;
      if (target?.closest(EDITABLE)) return;

      const folds = foldsOf(root);
      if (folds.length === 0) return;

      const current = currentIndex(folds);
      let next: number;

      switch (event.key) {
        case "ArrowDown":
        case "PageDown":
          next = current + 1;
          break;
        case "ArrowUp":
        case "PageUp":
          next = current - 1;
          break;
        case " ":
        case "Spacebar":
          // Space activates buttons; never take it from one.
          if (target?.closest(ACTIVATABLE)) return;
          next = event.shiftKey ? current - 1 : current + 1;
          break;
        case "Home":
          next = 0;
          break;
        case "End":
          next = folds.length - 1;
          break;
        default:
          return;
      }

      // At either end, hand the key back to the browser rather than swallow it.
      if (next < 0 || next > folds.length - 1 || next === current) return;

      event.preventDefault();
      goTo(folds[next]);
    };

    const onResize = () => {
      syncFit();
      syncActive();
    };

    window.addEventListener("scroll", syncActive, { passive: true });
    window.addEventListener("resize", onResize);
    window.addEventListener("keydown", onKeyDown);

    // Fonts land after first paint and change fold heights.
    document.fonts?.ready.then(syncFit).catch(() => {});

    syncFit();
    syncActive();

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", syncActive);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("keydown", onKeyDown);
      delete document.documentElement.dataset.deckFit;
    };
  }, []);

  return (
    <div
      aria-hidden="true"
      data-deck-rail=""
      className="pointer-events-none fixed top-1/2 right-3 z-20 hidden -translate-y-1/2 flex-col gap-2.5 sm:right-4 md:flex"
    >
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          data-on={i === active ? "" : undefined}
          className="h-1.5 w-1.5 rounded-full bg-zinc-100/20 transition-all duration-300 data-[on]:h-5 data-[on]:bg-emerald-400"
        />
      ))}
    </div>
  );
}
