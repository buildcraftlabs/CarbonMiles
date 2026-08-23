import { eq } from "drizzle-orm";

import { states } from "../../schema/geography";
import { countsOf, planSeed, type SeedCounts } from "../diff";
import type { SeedModule, SeedTx } from "../types";

type StateRow = {
  code: string;
  name: string;
  isUnionTerritory: boolean;
  region: string;
};

/**
 * The 28 states and 8 union territories, keyed by the two-letter code the RTO
 * system uses. Everything downstream — on-road price factors, fuel prices,
 * electricity tariffs, variant availability — hangs off these codes, so this is
 * the first module in the registry.
 *
 * `region` is a coarse grouping used only as a fallback: when a state has no
 * row of its own in a reference table, the engine averages its region rather
 * than the whole country.
 */
const STATES: readonly StateRow[] = [
  { code: "AP", name: "Andhra Pradesh", isUnionTerritory: false, region: "South" },
  { code: "AR", name: "Arunachal Pradesh", isUnionTerritory: false, region: "Northeast" },
  { code: "AS", name: "Assam", isUnionTerritory: false, region: "Northeast" },
  { code: "BR", name: "Bihar", isUnionTerritory: false, region: "East" },
  { code: "CG", name: "Chhattisgarh", isUnionTerritory: false, region: "Central" },
  { code: "GA", name: "Goa", isUnionTerritory: false, region: "West" },
  { code: "GJ", name: "Gujarat", isUnionTerritory: false, region: "West" },
  { code: "HR", name: "Haryana", isUnionTerritory: false, region: "North" },
  { code: "HP", name: "Himachal Pradesh", isUnionTerritory: false, region: "North" },
  { code: "JH", name: "Jharkhand", isUnionTerritory: false, region: "East" },
  { code: "KA", name: "Karnataka", isUnionTerritory: false, region: "South" },
  { code: "KL", name: "Kerala", isUnionTerritory: false, region: "South" },
  { code: "MP", name: "Madhya Pradesh", isUnionTerritory: false, region: "Central" },
  { code: "MH", name: "Maharashtra", isUnionTerritory: false, region: "West" },
  { code: "MN", name: "Manipur", isUnionTerritory: false, region: "Northeast" },
  { code: "ML", name: "Meghalaya", isUnionTerritory: false, region: "Northeast" },
  { code: "MZ", name: "Mizoram", isUnionTerritory: false, region: "Northeast" },
  { code: "NL", name: "Nagaland", isUnionTerritory: false, region: "Northeast" },
  { code: "OD", name: "Odisha", isUnionTerritory: false, region: "East" },
  { code: "PB", name: "Punjab", isUnionTerritory: false, region: "North" },
  { code: "RJ", name: "Rajasthan", isUnionTerritory: false, region: "North" },
  { code: "SK", name: "Sikkim", isUnionTerritory: false, region: "Northeast" },
  { code: "TN", name: "Tamil Nadu", isUnionTerritory: false, region: "South" },
  { code: "TS", name: "Telangana", isUnionTerritory: false, region: "South" },
  { code: "TR", name: "Tripura", isUnionTerritory: false, region: "Northeast" },
  { code: "UP", name: "Uttar Pradesh", isUnionTerritory: false, region: "North" },
  { code: "UK", name: "Uttarakhand", isUnionTerritory: false, region: "North" },
  { code: "WB", name: "West Bengal", isUnionTerritory: false, region: "East" },

  { code: "AN", name: "Andaman and Nicobar Islands", isUnionTerritory: true, region: "East" },
  { code: "CH", name: "Chandigarh", isUnionTerritory: true, region: "North" },
  {
    code: "DD",
    name: "Dadra and Nagar Haveli and Daman and Diu",
    isUnionTerritory: true,
    region: "West",
  },
  { code: "DL", name: "Delhi", isUnionTerritory: true, region: "North" },
  { code: "JK", name: "Jammu and Kashmir", isUnionTerritory: true, region: "North" },
  { code: "LA", name: "Ladakh", isUnionTerritory: true, region: "North" },
  { code: "LD", name: "Lakshadweep", isUnionTerritory: true, region: "South" },
  { code: "PY", name: "Puducherry", isUnionTerritory: true, region: "South" },
];

export const STATE_CODES: readonly string[] = STATES.map((s) => s.code);

async function run(tx: SeedTx): Promise<SeedCounts> {
  const existing = await tx
    .select({
      code: states.code,
      name: states.name,
      isUnionTerritory: states.isUnionTerritory,
      region: states.region,
    })
    .from(states);

  const plan = planSeed(
    STATES,
    existing,
    (row) => row.code,
    (desired, current) =>
      desired.name === current.name &&
      desired.isUnionTerritory === current.isUnionTerritory &&
      desired.region === current.region,
  );

  if (plan.toInsert.length > 0) {
    await tx.insert(states).values(plan.toInsert);
  }
  for (const row of plan.toUpdate) {
    await tx
      .update(states)
      .set({ name: row.name, isUnionTerritory: row.isUnionTerritory, region: row.region })
      .where(eq(states.code, row.code));
  }

  return countsOf(plan);
}

export const statesModule: SeedModule = {
  name: "states",
  description: "28 states and 8 union territories, keyed by RTO code",
  run,
};
