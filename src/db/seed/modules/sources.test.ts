import { describe, expect, it } from "vitest";

import { SEED_MODULES } from "../index";
import { SOURCE_SEED_ROWS, sourcesModule } from "./sources";

const SOURCE_TIERS = new Set([
  "oem",
  "government",
  "industry_body",
  "licensed_aggregator",
  "editorial",
  "community",
  "internal_estimate",
]);

describe("sources seed data", () => {
  it("gives every source a unique slug", () => {
    const slugs = SOURCE_SEED_ROWS.map((row) => row.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("uses only the tiers the enum defines", () => {
    for (const row of SOURCE_SEED_ROWS) {
      expect(SOURCE_TIERS.has(row.tier), row.slug).toBe(true);
    }
  });

  it("names every source and keeps the slug machine-shaped", () => {
    for (const row of SOURCE_SEED_ROWS) {
      expect(row.name.trim().length, row.slug).toBeGreaterThan(0);
      expect(row.slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });

  it("records no homepage URL and no crawl permission that nobody has verified", () => {
    // A URL written from memory is a fabricated citation, and these rows are
    // what the `sources` block of every API response is built from. `false` is
    // the correct answer to "may we crawl this?" until someone has read the
    // terms and said otherwise.
    for (const row of SOURCE_SEED_ROWS) {
      expect(row.homepageUrl, row.slug).toBeNull();
      expect(row.crawlAllowed, row.slug).toBe(false);
    }
  });

  it("carries a source for internal modelling conventions, tiered apart from facts", () => {
    const internal = SOURCE_SEED_ROWS.find((row) => row.tier === "internal_estimate");
    expect(internal?.slug).toBe("carbonmiles-modelling");
  });
});

describe("registry placement", () => {
  it("runs sources first — fact_provenance.source_id is NOT NULL and restricts deletes", () => {
    expect(SEED_MODULES[0]).toBe(sourcesModule);
    expect(sourcesModule.name).toBe("sources");
  });
});
