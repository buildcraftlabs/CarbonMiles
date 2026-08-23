import { citiesModule } from "./modules/cities";
import { sourcesModule } from "./modules/sources";
import { statesModule } from "./modules/states";
import type { SeedModule } from "./types";

/**
 * The registry, in dependency order. Modules run top to bottom in one
 * transaction, so anything with a foreign key must come after its target.
 *
 * `sources` is first: `fact_provenance.sourceId` is NOT NULL with
 * `onDelete: "restrict"`, so every provenance-aware module downstream is
 * unable to write a single row until these exist.
 *
 * Catalogue, economics and E20 content are seeded through `importEntities`,
 * which writes `fact_provenance` alongside the facts themselves. Those modules
 * register here too, after `sources`.
 */
export const SEED_MODULES: readonly SeedModule[] = [sourcesModule, statesModule, citiesModule];

/**
 * Re-exported by name rather than with `export *`. This package has no
 * `"type": "module"`, so these files transpile to CommonJS, and a star
 * re-export becomes a runtime call that Node's ESM lexer cannot see — an
 * `.mts` entry point importing from here would find the names missing.
 */
export { countsOf, planSeed } from "./diff";
export type { ProvenanceCounts, SeedCounts, SeedPlan } from "./diff";
export { importEntities, loadSourceIds, sqlColumnName } from "./importer";
export type { ImportSpec, ImportableTable } from "./importer";
export {
  buildProvenanceRows,
  planFieldChanges,
  planProvenance,
  sameAuthoredColumns,
  sameColumnValue,
  splitEntity,
  todayIso,
} from "./provenance";
export type {
  ConfidenceLevel,
  DesiredProvenance,
  ExistingProvenance,
  FieldChange,
  ProvenancePlan,
  SeedEntity,
  SeedFact,
  Sourced,
} from "./provenance";
export { formatReport, runSeed, selectModules, sumCounts } from "./runner";
export type { ModuleReport, SeedOptions, SeedReport } from "./runner";
export { SOURCE_SEED_ROWS, sourcesModule } from "./modules/sources";
export type { SeedModule, SeedTx } from "./types";
