import { eq } from "drizzle-orm";

import { cities } from "../../schema/geography";
import { countsOf, planSeed, type SeedCounts } from "../diff";
import type { SeedModule, SeedTx } from "../types";

type CityRow = {
  slug: string;
  name: string;
  stateCode: string;
  /** 1 or 2 on the government's X/Y house-rent classification. */
  tier: number;
  latitude: string;
  longitude: string;
};

/**
 * The metros and large cities the product actually asks about. Not exhaustive —
 * a user in a town we do not list falls back to their state, which is what the
 * reference tables are keyed on anyway. Coordinates exist so the infrastructure
 * layer can measure distance to the nearest charger or CNG pump.
 *
 * Tier follows the Central government's X/Y city classification (X → 1, Y → 2);
 * it drives default assumptions, not any user-visible claim. `population` is
 * left null on purpose: no figure goes in without a source row behind it.
 */
const CITIES: readonly CityRow[] = [
  { slug: "mumbai", name: "Mumbai", stateCode: "MH", tier: 1, latitude: "19.076000", longitude: "72.877700" },
  { slug: "delhi", name: "Delhi", stateCode: "DL", tier: 1, latitude: "28.613900", longitude: "77.209000" },
  { slug: "bengaluru", name: "Bengaluru", stateCode: "KA", tier: 1, latitude: "12.971600", longitude: "77.594600" },
  { slug: "hyderabad", name: "Hyderabad", stateCode: "TS", tier: 1, latitude: "17.385000", longitude: "78.486700" },
  { slug: "chennai", name: "Chennai", stateCode: "TN", tier: 1, latitude: "13.082700", longitude: "80.270700" },
  { slug: "kolkata", name: "Kolkata", stateCode: "WB", tier: 1, latitude: "22.572600", longitude: "88.363900" },
  { slug: "pune", name: "Pune", stateCode: "MH", tier: 1, latitude: "18.520400", longitude: "73.856700" },
  { slug: "ahmedabad", name: "Ahmedabad", stateCode: "GJ", tier: 1, latitude: "23.022500", longitude: "72.571400" },

  { slug: "jaipur", name: "Jaipur", stateCode: "RJ", tier: 2, latitude: "26.912400", longitude: "75.787300" },
  { slug: "lucknow", name: "Lucknow", stateCode: "UP", tier: 2, latitude: "26.846700", longitude: "80.946200" },
  { slug: "surat", name: "Surat", stateCode: "GJ", tier: 2, latitude: "21.170200", longitude: "72.831100" },
  { slug: "kanpur", name: "Kanpur", stateCode: "UP", tier: 2, latitude: "26.449900", longitude: "80.331900" },
  { slug: "nagpur", name: "Nagpur", stateCode: "MH", tier: 2, latitude: "21.145800", longitude: "79.088200" },
  { slug: "indore", name: "Indore", stateCode: "MP", tier: 2, latitude: "22.719600", longitude: "75.857700" },
  { slug: "bhopal", name: "Bhopal", stateCode: "MP", tier: 2, latitude: "23.259900", longitude: "77.412600" },
  { slug: "visakhapatnam", name: "Visakhapatnam", stateCode: "AP", tier: 2, latitude: "17.686800", longitude: "83.218500" },
  { slug: "patna", name: "Patna", stateCode: "BR", tier: 2, latitude: "25.594100", longitude: "85.137600" },
  { slug: "vadodara", name: "Vadodara", stateCode: "GJ", tier: 2, latitude: "22.307200", longitude: "73.181200" },
  { slug: "ludhiana", name: "Ludhiana", stateCode: "PB", tier: 2, latitude: "30.901000", longitude: "75.857300" },
  { slug: "agra", name: "Agra", stateCode: "UP", tier: 2, latitude: "27.176700", longitude: "78.008100" },
  { slug: "nashik", name: "Nashik", stateCode: "MH", tier: 2, latitude: "19.997500", longitude: "73.789800" },
  { slug: "coimbatore", name: "Coimbatore", stateCode: "TN", tier: 2, latitude: "11.016800", longitude: "76.955800" },
  { slug: "kochi", name: "Kochi", stateCode: "KL", tier: 2, latitude: "9.931200", longitude: "76.267300" },
  { slug: "chandigarh", name: "Chandigarh", stateCode: "CH", tier: 2, latitude: "30.733300", longitude: "76.779400" },
  { slug: "guwahati", name: "Guwahati", stateCode: "AS", tier: 2, latitude: "26.144500", longitude: "91.736200" },
  { slug: "bhubaneswar", name: "Bhubaneswar", stateCode: "OD", tier: 2, latitude: "20.296100", longitude: "85.824500" },
  { slug: "dehradun", name: "Dehradun", stateCode: "UK", tier: 2, latitude: "30.316500", longitude: "78.032200" },
  { slug: "raipur", name: "Raipur", stateCode: "CG", tier: 2, latitude: "21.251400", longitude: "81.629600" },
  { slug: "ranchi", name: "Ranchi", stateCode: "JH", tier: 2, latitude: "23.344100", longitude: "85.309600" },
  { slug: "thiruvananthapuram", name: "Thiruvananthapuram", stateCode: "KL", tier: 2, latitude: "8.524100", longitude: "76.936600" },
  { slug: "mysuru", name: "Mysuru", stateCode: "KA", tier: 2, latitude: "12.295800", longitude: "76.639400" },
  { slug: "madurai", name: "Madurai", stateCode: "TN", tier: 2, latitude: "9.925200", longitude: "78.119800" },
  { slug: "varanasi", name: "Varanasi", stateCode: "UP", tier: 2, latitude: "25.317600", longitude: "82.973900" },
  { slug: "amritsar", name: "Amritsar", stateCode: "PB", tier: 2, latitude: "31.634000", longitude: "74.872300" },
  { slug: "rajkot", name: "Rajkot", stateCode: "GJ", tier: 2, latitude: "22.303900", longitude: "70.802200" },
];

/** Postgres hands numerics back zero-padded to the column scale, so compare by
 * value rather than by string or every run would report a spurious update. */
function sameNumeric(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return Number(a) === Number(b);
}

async function run(tx: SeedTx): Promise<SeedCounts> {
  const existing = await tx
    .select({
      slug: cities.slug,
      name: cities.name,
      stateCode: cities.stateCode,
      tier: cities.tier,
      latitude: cities.latitude,
      longitude: cities.longitude,
    })
    .from(cities);

  const plan = planSeed(
    CITIES,
    existing,
    (row) => row.slug,
    (desired, current) =>
      desired.name === current.name &&
      desired.stateCode === current.stateCode &&
      desired.tier === current.tier &&
      sameNumeric(desired.latitude, current.latitude) &&
      sameNumeric(desired.longitude, current.longitude),
  );

  if (plan.toInsert.length > 0) {
    await tx.insert(cities).values(plan.toInsert);
  }
  for (const row of plan.toUpdate) {
    await tx
      .update(cities)
      .set({
        name: row.name,
        stateCode: row.stateCode,
        tier: row.tier,
        latitude: row.latitude,
        longitude: row.longitude,
      })
      .where(eq(cities.slug, row.slug));
  }

  return countsOf(plan);
}

export const citiesModule: SeedModule = {
  name: "cities",
  description: "35 metros and large cities with coordinates and tier",
  run,
};

export const CITY_SEED_ROWS = CITIES;
