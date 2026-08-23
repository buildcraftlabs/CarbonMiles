import { citiesModule } from "./modules/cities";
import { statesModule } from "./modules/states";
import type { SeedModule } from "./types";

/**
 * The registry, in dependency order. Modules run top to bottom in one
 * transaction, so anything with a foreign key must come after its target.
 *
 * Catalogue, economics and E20 content are not seeded from here — they arrive
 * through the provenance-aware importer and register their own modules.
 */
export const SEED_MODULES: readonly SeedModule[] = [statesModule, citiesModule];

/**
 * Re-exported by name rather than with `export *`. This package has no
 * `"type": "module"`, so these files transpile to CommonJS, and a star
 * re-export becomes a runtime call that Node's ESM lexer cannot see — an
 * `.mts` entry point importing from here would find the names missing.
 */
export { countsOf, planSeed } from "./diff";
export type { SeedCounts, SeedPlan } from "./diff";
export { formatReport, runSeed, selectModules, sumCounts } from "./runner";
export type { ModuleReport, SeedOptions, SeedReport } from "./runner";
export type { SeedModule, SeedTx } from "./types";
