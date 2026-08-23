import { eq } from "drizzle-orm";

import { sources } from "../../schema/sources";
import { countsOf, planSeed, type SeedCounts } from "../diff";
import type { SeedModule, SeedTx } from "../types";

type SourceTier =
  | "oem"
  | "government"
  | "industry_body"
  | "licensed_aggregator"
  | "editorial"
  | "community"
  | "internal_estimate";

type SourceRow = {
  slug: string;
  name: string;
  tier: SourceTier;
  homepageUrl: string | null;
  crawlAllowed: boolean;
  crawlNotes: string | null;
};

/**
 * The origins facts are allowed to come from.
 *
 * `fact_provenance.sourceId` is `NOT NULL` with `onDelete: "restrict"`, so no
 * fact can be written before its source exists — which is why this module is
 * first in the registry, ahead of even geography.
 *
 * This list is deliberately short. It holds only origins that can be named
 * exactly, and it records nothing about them that has not been established:
 *
 * - `homepageUrl` is null throughout. A URL written from memory is a fabricated
 *   citation, and these rows are what the `sources` block of every API response
 *   is built from. Filling them in is part of curation, not of the mechanism.
 * - `crawlAllowed` stays at its `false` default and `lastCheckedAt` stays null,
 *   because nobody has read these organisations' terms yet. `false` is the
 *   correct answer to "may we crawl this?" until somebody has.
 *
 * OEM sources are per-manufacturer (`oem-<manufacturer-slug>`) and arrive with
 * the catalogue curation issues, alongside the variants that cite them. Adding
 * empty placeholders for them here would be inventing sources for facts that do
 * not exist yet.
 */
const SOURCE_ROWS: readonly SourceRow[] = [
  {
    slug: "morth",
    name: "Ministry of Road Transport and Highways, Government of India",
    tier: "government",
    homepageUrl: null,
    crawlAllowed: false,
    crawlNotes: "Crawl permissions not assessed yet.",
  },
  {
    slug: "vahan",
    name: "VAHAN national vehicle registration database (MoRTH)",
    tier: "government",
    homepageUrl: null,
    crawlAllowed: false,
    crawlNotes: "Crawl permissions not assessed yet.",
  },
  {
    slug: "ppac",
    name: "Petroleum Planning and Analysis Cell, Ministry of Petroleum and Natural Gas",
    tier: "government",
    homepageUrl: null,
    crawlAllowed: false,
    crawlNotes: "Crawl permissions not assessed yet.",
  },
  {
    slug: "cea",
    name: "Central Electricity Authority, Government of India",
    tier: "government",
    homepageUrl: null,
    crawlAllowed: false,
    crawlNotes: "Crawl permissions not assessed yet.",
  },
  {
    slug: "bee",
    name: "Bureau of Energy Efficiency, Government of India",
    tier: "government",
    homepageUrl: null,
    crawlAllowed: false,
    crawlNotes: "Crawl permissions not assessed yet.",
  },
  {
    /**
     * ARAI is the testing agency behind the certified efficiency and emission
     * figures. Tiered `industry_body` rather than `government`: it is a
     * research association, working under the administrative control of a
     * ministry but not itself an arm of one. The tier gates which facts may be
     * published from it, so the conservative reading is the right one.
     */
    slug: "arai",
    name: "Automotive Research Association of India",
    tier: "industry_body",
    homepageUrl: null,
    crawlAllowed: false,
    crawlNotes: "Crawl permissions not assessed yet.",
  },
  {
    slug: "siam",
    name: "Society of Indian Automobile Manufacturers",
    tier: "industry_body",
    homepageUrl: null,
    crawlAllowed: false,
    crawlNotes: "Crawl permissions not assessed yet.",
  },
  {
    /**
     * Modelling conventions are not facts, but they are still assumptions a
     * user is entitled to see attributed. Anything derived from a formula in
     * docs/RECOMMENDATION-ENGINE.md rather than measured cites this, and the
     * `internal_estimate` tier keeps it visibly distinct from a sourced fact.
     */
    slug: "carbonmiles-modelling",
    name: "Carbon Miles internal modelling convention",
    tier: "internal_estimate",
    homepageUrl: null,
    crawlAllowed: false,
    crawlNotes: "Not a fetched source; derived in-house.",
  },
];

async function run(tx: SeedTx): Promise<SeedCounts> {
  const existing = await tx
    .select({
      slug: sources.slug,
      name: sources.name,
      tier: sources.tier,
      homepageUrl: sources.homepageUrl,
      crawlAllowed: sources.crawlAllowed,
      crawlNotes: sources.crawlNotes,
    })
    .from(sources);

  const plan = planSeed(
    SOURCE_ROWS,
    existing,
    (row) => row.slug,
    (desired, current) =>
      desired.name === current.name &&
      desired.tier === current.tier &&
      desired.homepageUrl === current.homepageUrl &&
      desired.crawlAllowed === current.crawlAllowed &&
      desired.crawlNotes === current.crawlNotes,
  );

  if (plan.toInsert.length > 0) {
    await tx.insert(sources).values(plan.toInsert);
  }
  for (const row of plan.toUpdate) {
    // `lastCheckedAt` is left alone on purpose: it belongs to whoever actually
    // rechecked the source's terms, not to a seed run.
    await tx
      .update(sources)
      .set({
        name: row.name,
        tier: row.tier,
        homepageUrl: row.homepageUrl,
        crawlAllowed: row.crawlAllowed,
        crawlNotes: row.crawlNotes,
      })
      .where(eq(sources.slug, row.slug));
  }

  return countsOf(plan);
}

export const sourcesModule: SeedModule = {
  name: "sources",
  description: "Named origins every fact_provenance row points at",
  run,
};

export const SOURCE_SEED_ROWS = SOURCE_ROWS;
