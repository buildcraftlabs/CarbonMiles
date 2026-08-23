import { describe, expect, it } from "vitest";

import { SEED_MODULES } from "./index";
import { CITY_SEED_ROWS } from "./modules/cities";
import { STATE_CODES } from "./modules/states";
import { selectModules } from "./runner";
import type { SeedModule } from "./types";

const stub = (name: string): SeedModule => ({
  name,
  description: name,
  run: async () => ({ inserted: 0, updated: 0, unchanged: 0 }),
});

const REGISTRY = [stub("states"), stub("cities"), stub("sources")];

describe("selectModules", () => {
  it("runs the whole registry when no filter is given", () => {
    expect(selectModules(REGISTRY).map((m) => m.name)).toEqual(["states", "cities", "sources"]);
    expect(selectModules(REGISTRY, []).map((m) => m.name)).toEqual(["states", "cities", "sources"]);
  });

  it("keeps registry order regardless of the order flags were typed", () => {
    // cities has a foreign key onto states; honouring the typed order would
    // reverse them and the insert would fail.
    expect(selectModules(REGISTRY, ["cities", "states"]).map((m) => m.name)).toEqual([
      "states",
      "cities",
    ]);
  });

  it("fails loudly on an unknown module rather than silently seeding less", () => {
    expect(() => selectModules(REGISTRY, ["states", "nope"])).toThrow(
      /Unknown seed module\(s\): nope/,
    );
  });
});

describe("seed data", () => {
  it("registers modules with unique names", () => {
    const names = SEED_MODULES.map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("covers all 28 states and 8 union territories", () => {
    expect(STATE_CODES).toHaveLength(36);
    expect(new Set(STATE_CODES).size).toBe(36);
  });

  it("references only states that exist — every city FK would otherwise fail", () => {
    const known = new Set(STATE_CODES);
    const orphans = CITY_SEED_ROWS.filter((city) => !known.has(city.stateCode));
    expect(orphans).toEqual([]);
  });

  it("gives every city a unique slug and plausible Indian coordinates", () => {
    const slugs = CITY_SEED_ROWS.map((city) => city.slug);
    expect(new Set(slugs).size).toBe(slugs.length);

    for (const city of CITY_SEED_ROWS) {
      expect(Number(city.latitude), city.slug).toBeGreaterThan(6);
      expect(Number(city.latitude), city.slug).toBeLessThan(38);
      expect(Number(city.longitude), city.slug).toBeGreaterThan(68);
      expect(Number(city.longitude), city.slug).toBeLessThan(98);
    }
  });
});
