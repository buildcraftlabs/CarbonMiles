import type { Database } from "../client";
import type { ProvenanceCounts, SeedCounts } from "./diff";
import type { SeedModule } from "./types";

export type ModuleReport = {
  name: string;
  description: string;
  counts: SeedCounts;
  durationMs: number;
};

export type SeedReport = {
  modules: ModuleReport[];
  totals: SeedCounts;
  dryRun: boolean;
};

export type SeedOptions = {
  /** Module names to run; empty or omitted runs the whole registry in order. */
  only?: readonly string[];
  /** Execute everything, report real counts, then roll back. */
  dryRun?: boolean;
};

/**
 * Resolve `--only=` against the registry, preserving registry order rather than
 * the order the flags were typed — modules have foreign-key dependencies on one
 * another and running `--only=cities,states` must not reverse them.
 */
export function selectModules(
  registry: readonly SeedModule[],
  only?: readonly string[],
): SeedModule[] {
  if (only === undefined || only.length === 0) return [...registry];

  const known = new Set(registry.map((m) => m.name));
  const unknown = only.filter((name) => !known.has(name));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown seed module(s): ${unknown.join(", ")}. ` +
        `Available: ${registry.map((m) => m.name).join(", ")}`,
    );
  }

  const wanted = new Set(only);
  return registry.filter((m) => wanted.has(m.name));
}

/** Thrown to unwind a dry run; never escapes `runSeed`. */
class DryRunRollback extends Error {
  constructor(readonly report: SeedReport) {
    super("dry run rollback");
  }
}

/**
 * Run the selected modules inside a single transaction. One transaction for the
 * whole run — not one per module — so a failure in the fifth module cannot
 * leave the first four committed and the database in a state no seed file
 * describes.
 */
export async function runSeed(
  db: Database,
  registry: readonly SeedModule[],
  options: SeedOptions = {},
): Promise<SeedReport> {
  const modules = selectModules(registry, options.only);
  const dryRun = options.dryRun ?? false;

  try {
    return await db.transaction(async (tx) => {
      const reports: ModuleReport[] = [];
      for (const seedModule of modules) {
        const startedAt = performance.now();
        const counts = await seedModule.run(tx);
        reports.push({
          name: seedModule.name,
          description: seedModule.description,
          counts,
          durationMs: Math.round(performance.now() - startedAt),
        });
      }

      const report: SeedReport = { modules: reports, totals: sumCounts(reports), dryRun };
      if (dryRun) throw new DryRunRollback(report);
      return report;
    });
  } catch (error) {
    if (error instanceof DryRunRollback) return error.report;
    throw error;
  }
}

/**
 * Totals across the run. The `provenance` bucket appears only if at least one
 * module reported one, so a `--only=states,cities` run keeps a clean total
 * instead of claiming it examined provenance it never looked at.
 */
export function sumCounts(reports: readonly ModuleReport[]): SeedCounts {
  const totals = reports.reduce<SeedCounts>(
    (total, report) => ({
      inserted: total.inserted + report.counts.inserted,
      updated: total.updated + report.counts.updated,
      unchanged: total.unchanged + report.counts.unchanged,
    }),
    { inserted: 0, updated: 0, unchanged: 0 },
  );

  const withProvenance = reports.filter((report) => report.counts.provenance !== undefined);
  if (withProvenance.length === 0) return totals;

  return {
    ...totals,
    provenance: withProvenance.reduce<ProvenanceCounts>(
      (total, report) => ({
        recorded: total.recorded + (report.counts.provenance?.recorded ?? 0),
        superseded: total.superseded + (report.counts.provenance?.superseded ?? 0),
        unchanged: total.unchanged + (report.counts.provenance?.unchanged ?? 0),
      }),
      { recorded: 0, superseded: 0, unchanged: 0 },
    ),
  };
}

/** `prov +12 ~3 =40` — appended only where a module actually wrote provenance. */
function formatProvenance(counts: ProvenanceCounts | undefined): string {
  if (counts === undefined) return "";
  return (
    `  prov +${String(counts.recorded).padStart(4)} ` +
    `~${String(counts.superseded).padStart(4)} ` +
    `=${String(counts.unchanged).padStart(4)}`
  );
}

export function formatReport(report: SeedReport): string {
  const lines = report.modules.map((m) => {
    const { inserted, updated, unchanged } = m.counts;
    return (
      `  ${m.name.padEnd(18)} ` +
      `+${String(inserted).padStart(4)} ` +
      `~${String(updated).padStart(4)} ` +
      `=${String(unchanged).padStart(4)}` +
      formatProvenance(m.counts.provenance) +
      `  ${m.durationMs}ms`
    );
  });

  const { inserted, updated, unchanged } = report.totals;
  lines.push(
    `  ${"TOTAL".padEnd(18)} ` +
      `+${String(inserted).padStart(4)} ` +
      `~${String(updated).padStart(4)} ` +
      `=${String(unchanged).padStart(4)}` +
      formatProvenance(report.totals.provenance),
  );
  if (report.dryRun) lines.push("\n  DRY RUN — transaction rolled back, nothing was written.");
  return lines.join("\n");
}
