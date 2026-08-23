import { describe, expect, it } from "vitest";

import { countsOf, planSeed } from "./diff";

type Row = { code: string; name: string };

const keyOf = (row: Row) => row.code;
const matches = (a: Row, b: Row) => a.name === b.name;

describe("planSeed", () => {
  it("treats an empty table as all inserts", () => {
    const plan = planSeed([{ code: "MH", name: "Maharashtra" }], [], keyOf, matches);

    expect(countsOf(plan)).toEqual({ inserted: 1, updated: 0, unchanged: 0 });
    expect(plan.toInsert).toEqual([{ code: "MH", name: "Maharashtra" }]);
  });

  it("is a no-op on a second run — nothing to insert or update", () => {
    const desired: Row[] = [
      { code: "MH", name: "Maharashtra" },
      { code: "KA", name: "Karnataka" },
    ];

    const plan = planSeed(desired, desired, keyOf, matches);

    expect(countsOf(plan)).toEqual({ inserted: 0, updated: 0, unchanged: 2 });
  });

  it("separates changed rows from unchanged ones", () => {
    const plan = planSeed(
      [
        { code: "MH", name: "Maharashtra" },
        { code: "KA", name: "Karnataka" },
        { code: "TN", name: "Tamil Nadu" },
      ],
      [
        { code: "MH", name: "Maharashtra" },
        { code: "KA", name: "Mysore" },
      ],
      keyOf,
      matches,
    );

    expect(countsOf(plan)).toEqual({ inserted: 1, updated: 1, unchanged: 1 });
    expect(plan.toInsert.map(keyOf)).toEqual(["TN"]);
    expect(plan.toUpdate).toEqual([{ code: "KA", name: "Karnataka" }]);
  });

  it("leaves rows the seed no longer mentions alone", () => {
    const plan = planSeed(
      [{ code: "MH", name: "Maharashtra" }],
      [
        { code: "MH", name: "Maharashtra" },
        { code: "XX", name: "Curated by hand" },
      ],
      keyOf,
      matches,
    );

    expect(countsOf(plan)).toEqual({ inserted: 0, updated: 0, unchanged: 1 });
  });

  it("rejects a seed file with a duplicated natural key", () => {
    expect(() =>
      planSeed(
        [
          { code: "MH", name: "Maharashtra" },
          { code: "MH", name: "Maharashtra (again)" },
        ],
        [],
        keyOf,
        matches,
      ),
    ).toThrow(/Duplicate seed key: MH/);
  });
});
