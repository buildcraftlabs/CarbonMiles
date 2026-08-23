import { describe, expect, it } from "vitest";

import type { SeedCounts } from "./diff";
import { formatReport, sumCounts, type ModuleReport } from "./runner";

const report = (name: string, counts: SeedCounts): ModuleReport => ({
  name,
  description: name,
  counts,
  durationMs: 1,
});

describe("sumCounts", () => {
  it("leaves the provenance bucket off a run where no module reported one", () => {
    const totals = sumCounts([
      report("states", { inserted: 36, updated: 0, unchanged: 0 }),
      report("cities", { inserted: 35, updated: 0, unchanged: 0 }),
    ]);

    // Not `{ recorded: 0, ... }` — an all-zero bucket would read as "checked,
    // nothing to do" on a run that never looked at provenance at all.
    expect(totals).toEqual({ inserted: 71, updated: 0, unchanged: 0 });
    expect("provenance" in totals).toBe(false);
  });

  it("sums the provenance bucket across the modules that carry one", () => {
    const totals = sumCounts([
      report("states", { inserted: 1, updated: 0, unchanged: 0 }),
      report("variants", {
        inserted: 2,
        updated: 1,
        unchanged: 3,
        provenance: { recorded: 8, superseded: 2, unchanged: 12 },
      }),
      report("economics", {
        inserted: 0,
        updated: 0,
        unchanged: 5,
        provenance: { recorded: 1, superseded: 1, unchanged: 4 },
      }),
    ]);

    expect(totals).toEqual({
      inserted: 3,
      updated: 1,
      unchanged: 8,
      provenance: { recorded: 9, superseded: 3, unchanged: 16 },
    });
  });
});

describe("formatReport", () => {
  it("appends a prov column only to the modules that wrote provenance", () => {
    const modules = [
      report("states", { inserted: 36, updated: 0, unchanged: 0 }),
      report("variants", {
        inserted: 2,
        updated: 1,
        unchanged: 3,
        provenance: { recorded: 8, superseded: 2, unchanged: 12 },
      }),
    ];

    const lines = formatReport({ modules, totals: sumCounts(modules), dryRun: false }).split("\n");

    expect(lines[0]).not.toContain("prov");
    expect(lines[1]).toContain("prov");
    expect(lines[2]).toContain("TOTAL");
    expect(lines[2]).toContain("prov");
  });

  it("says out loud that a dry run wrote nothing", () => {
    const modules = [report("states", { inserted: 36, updated: 0, unchanged: 0 })];
    const text = formatReport({ modules, totals: sumCounts(modules), dryRun: true });

    expect(text).toMatch(/DRY RUN/);
  });
});
