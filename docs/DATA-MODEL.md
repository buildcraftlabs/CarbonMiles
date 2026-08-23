# Carbon Miles — Data Model

Status: current as of migration `0001` · Last reviewed: 2026-08-23

Nine schema modules under `src/db/schema/`, 38 tables, 12 enums, 68 declared
indexes excluding primary keys. This document explains *why* each table looks
the way it does; the tables themselves are the source of truth for *what*.

Related: [ARCHITECTURE.md](./ARCHITECTURE.md) · [PRD.md](./PRD.md)

---

## 1. Conventions

**Money is paise, stored as `bigint`.** An ex-showroom price of ₹50 L is 5×10⁹
paise, past int32, and float rupees drift once compounded across a ten-year TCO
horizon. Every `*Paise` column is an integer count of paise. LLM cost is stored
in micro-USD for the same reason: sub-cent numbers as integers.

**Claimed versus real-world is a hard split.** `claimedEfficiency` and
`claimedRangeKm` exist for display, because a buyer expects to see the ARAI
number. `realWorldEfficiencyCity`, `realWorldEfficiencyHighway` and
`realWorldRangeKm` are what every calculation uses. ARAI figures overstate real
economy and would bias every recommendation in the same direction.

**Efficiency units differ by fuel.** kmpl for petrol/diesel, km/kg for CNG,
km/kWh for electric. `efficiencyUnit` carries the unit; nothing infers it.

**Dated reference data.** Every table whose values move — fuel prices, tariffs,
curves, battery costs, finance rates, emission factors, infrastructure density —
carries an `asOf` date, and the UI shows that date next to any figure derived
from it. Rows are appended, not updated in place, so a past run stays
reproducible.

**Identity.** `uuid` primary keys with `defaultRandom()` everywhere except
`states`, which is keyed by its two-letter RTO code because that code *is* the
identifier every other table wants to join on. Public-facing tables also carry a
unique `slug` for stable URLs.

**Timestamps.** `timestamp with time zone`, `createdAt` defaulting to `now()`.
`date` (no time) where the value is a business date rather than an instant.

**Casing.** Drizzle is configured with `casing: "snake_case"` in both
`drizzle.config.ts` and `src/db/client.ts`, so columns are declared without
explicit SQL names. If those two ever disagree, generated SQL drifts silently.

**Extensions.** `vector` and `pg_trgm` are hand-prepended to
`drizzle/0000_init.sql` — drizzle-kit does not emit `CREATE EXTENSION`. Re-check
after regenerating a baseline migration.

---

## 2. `enums` — 12 shared enumerations

No tables. Everything the schema needs to agree about, in one place:
`vehicle_category`, `fuel_type`, `body_type`, `transmission_type`, `drivetrain`,
`emission_norm`, `lifecycle_status`, `source_tier`, `confidence_level`,
`e20_verdict`, `risk_level`, `station_type`.

Two of these carry product decisions rather than taxonomy:

- **`emission_norm`** exists mainly because BS-VI phase 2 (April 2023 onward) is
  the dividing line for E20 readiness. It is a fact about a variant that doubles
  as an inference rule.
- **`source_tier`** — `oem` → `government` → `industry_body` →
  `licensed_aggregator` → `editorial` → `community` → `internal_estimate`, best
  first. The ingestion pipeline refuses to publish a fact whose best source sits
  below the tier that field requires. This is what stops a forum post becoming a
  price.
- **`e20_verdict`** has five values, and `unknown` is one of them on purpose. A
  product that cannot say "we don't know" will eventually say something false.

---

## 3. `geography` — 2 tables

| Table | Purpose |
|---|---|
| `states` | 36 states and union territories, keyed by RTO code (`MH`, `KA`, `DL`) |
| `cities` | Major cities with population, tier, and coordinates |

`cities.tier` drives infrastructure expectations and the default assumptions
offered when a user does not know their own numbers — a tier-1 user who says
"about 40 km a day" and a tier-3 user who says the same thing are describing
different journeys.

Both are seeded (36 states, 35 cities) and are the only tables the seed harness
currently populates.

---

## 4. `sources` — 3 tables

The provenance spine. Every fact in the catalogue traces back through here.

### `sources`

One row per origin, with its trust tier and — importantly — its crawl
permissions. `crawlAllowed` gates the ingestion pipeline in code, which keeps the
legal boundary somewhere it will actually be enforced rather than in a policy
document nobody reads. `crawlAllowed = false` with a populated `crawlNotes` is
the normal state for a brochure PDF or a manually transcribed source.

### `fact_provenance`

Field-level provenance: one row per `(entityTable, entityId, field)`. Rather than
bolting a `sourceId` onto every fact-bearing column — which would roughly double
the width of `vehicle_variants` — provenance lives in its own table. That keeps
the catalogue readable while still making it impossible for a number to reach a
user unattributed.

Two properties worth knowing:

- `excerpt` holds the verbatim snippet, so a reviewer can check a value without
  refetching the source.
- `fact_provenance_current_key` is a **unique partial index** on
  `(entityTable, entityId, field) WHERE superseded_at IS NULL`. One current
  source per fact, unlimited history behind it.

**New fact-bearing columns must get a provenance row.** This is the rule that
makes `{ data, assumptions, sources }` possible in every API response.

### `data_quality`

A denormalised roll-up per row — score 0–100 from completeness × source tier ×
recency, plus the lists of missing and stale fields. Recomputed by the validation
job. Cheap to read at query time: the UI surfaces it as a confidence badge and
the engine uses it to break ties between otherwise equal vehicles.

Note it has no surrogate primary key; `data_quality_entity_key` is a unique index
on `(entityTable, entityId)` and serves that role.

---

## 5. `catalogue` — 4 tables

### `manufacturers`

Beyond the obvious, `serviceCentreCount` (with its own `asOf`) feeds the
reliability sub-score. A great vehicle you cannot get serviced in Nashik is not a
great vehicle for someone in Nashik.

### `vehicle_models`

Model-level identity plus the editorial layer: `summary`, `knownAdvantages`,
`knownDisadvantages`, `commonProblems` (a jsonb array of
`{ issue, typicalKm?, severity? }`). `segment` is the join key into the
maintenance and resale curves — the whole economics layer depends on this column
being assigned consistently.

### `vehicle_variants` — the workhorse

One row per buyable configuration. This is what the engine filters, scores and
ranks. Column groups:

| Group | Notable columns |
|---|---|
| Powertrain | `fuelType`, `transmission`, `emissionNorm`, `engineCc`, `powerBhp`, `torqueNm` |
| Electric / hybrid | `batteryKwh`, `batteryChemistry`, `realWorldRangeKm`, `dcChargeKw`, `dcChargeMinutes10To80`, battery warranty |
| Efficiency | `realWorldEfficiencyCity/Highway`, `efficiencyUnit`, `fuelTankLitres`, `cngTankKg` |
| Practicality | `seatingCapacity`, `bootLitres`, `payloadKg`, `gvwKg`, `deckLengthMm`, `groundClearanceMm` |
| Money | `exShowroomPaise`, `scheduledServiceCost5yPaise` |
| E20 | `e20Verdict` (denormalised for fast filtering; `e20_compatibility` is authoritative) |
| Hygiene | `dataQualityScore`, `lastVerifiedAt` |

`scheduledServiceCost5yPaise` is populated only where the manufacturer publishes
a service package. Where it is null, the economics engine falls back to the
segment maintenance curve — which is the common case.

The passenger and commercial catalogues share this table rather than splitting.
They differ in which columns are populated (`payloadKg`, `gvwKg`, `deckLengthMm`
for commercial; `bootLitres`, `seatingCapacity` for passenger) and in which
scoring weights apply, not in what a vehicle *is*. Splitting would duplicate
every economics join for no benefit.

### `variant_availability`

Which variants a buyer can actually take delivery of in a given state. **Absence
of a row means "assume available."** We record only known exclusions, because
tracking positive availability for every state × variant pair is a large
maintenance burden with almost no decision value.

---

## 6. `economics` — 9 tables

These are what make TCO real rather than a spec-sheet subtraction.

### `state_on_road_factors`

On-road price in India is ex-showroom plus state-set road tax, registration and
insurance — and road tax runs from roughly 6% to 20% by state, varying again by
price band and fuel within a state. A recommendation that quotes ex-showroom is
wrong by lakhs, and a buyer notices immediately.

Keyed by state, category, fuel and an inclusive-lower/exclusive-upper price band
in paise. `otherLevyPaise` goes negative for a rebate, which is how EV subsidies
and green cess share one column.

### `fuel_prices`

Daily, dated, per state and optionally per city, in paise per litre or per kg.
Two indexes: a uniqueness key on `(stateCode, cityId, fuelType, asOf)` and a
lookup index ordered for "latest price for this state and fuel".

### `electricity_tariffs`

`tariffKind` is one of `domestic_slab`, `ev_meter`, `public_ac`, `public_dc`,
with optional slab bounds. This table exists because EV running cost is dominated
by *where* the household charges: the spread across those four is roughly 4×,
which is larger than the spread between vehicles. Getting the vehicle right and
the tariff wrong produces a worse answer than the reverse.

### `maintenance_curves` and `resale_curves`

Both keyed by `(segment, fuelType, category, year, asOf)` — deliberately *not* by
variant. Per-variant service pricing and residuals are not published widely
enough to be reliable, and the segment curve is accurate enough to rank vehicles
against each other, which is what we actually need. Precision we cannot source is
worse than honest approximation, because it invites trust it has not earned.

`maintenance_curves.marginalCostPaisePerKm` extends the curve past its
`referenceAnnualKm` for high-usage users, so a 40,000 km/year commercial buyer
does not get a 12,000 km/year answer.

`resale_curves.liquidityScore` records how thin the used market is. A
high-residual vehicle nobody buys is not actually liquid, and commercial buyers
care about this more than they care about the headline percentage.

### `battery_costs`

Battery replacement is the single largest uncertainty in EV ownership cost. The
model here is probability-weighted rather than binary: `annualDegradationPct` and
`replacementThresholdPct` decide whether a replacement falls inside the ownership
horizon at all, and `pricePaisePerKwh` prices it if it does. Ignoring it flatters
EVs; assuming it always happens punishes them.

### `finance_rates`

By category, fuel and lender kind, with typical tenure, down payment and
processing fee. Financing changes the ranking, not just the total — a lower
sticker price at a worse rate can lose.

### `emission_factors`

Grams CO₂e per litre, kg or kWh, with a `scope` defaulting to `well_to_wheel` and
an optional `stateCode` for grid factors. These live in the database rather than
as constants precisely so they carry a source and a date: the grid factor
improves every year as renewables grow, and a stale constant quietly biases every
EV recommendation.

### `economics_refresh_log`

Audit trail for the scheduled jobs that keep the tables above current. Read by
the staleness alerting.

---

## 7. `e20` — 3 tables

The highest-liability data in the product.

### `e20_compatibility`

Scoped to either a model or a specific variant; **variant scope wins when both
exist.** Within one model, a 2019 BS-IV car and a 2024 BS-VI phase 2 car can have
genuinely different answers, and a model-level verdict would be wrong for one of
them. `appliesFrom`/`appliesTo` narrow further, because OEMs switch mid-model-year.

Carries the verdict, a `materialRiskLevel` covering fuel lines, gaskets, seals
and fuel-contact aluminium, and a mileage delta as a **range**
(`mileageDeltaMinPct`/`MaxPct`). Ethanol carries about a third less energy per
litre than petrol, so a drop is arithmetic rather than opinion; the *size* of the
drop depends on engine tuning, which is why it is a range and never a point.

`inferredFromNorm` marks a verdict derived from the BS-VI phase 2 rule rather
than an explicit OEM statement. This flag must reach the user — it is the
difference between "the manufacturer says" and "we infer".

Nothing is inferred here without a source (`sourceId` references `sources` with
`ON DELETE RESTRICT`), and the product never contradicts a published OEM position
held in `oemStatementSummary`.

### `e20_guidance_rules`

Deterministic guidance rows selected by verdict, minimum risk level, body type
(a jsonb containment test, GIN-indexed) and maximum year. `kind` is one of
`inspection`, `service_interval`, `driving_habit`, `component_upgrade`,
`fuel_practice`. `priority` sorts; the UI shows the top few and collapses the rest.

**The LLM phrases these rows. It does not choose them.**

### `e20_kb_chunks`

The only RAG surface in the product. Vehicle specifications never come from here.

Hybrid retrieval by design: a GIN index over
`to_tsvector('english', title || ' ' || content)` for lexical search, an HNSW
index over a 1536-dimension embedding for semantic search, and a GIN index over
`tags` to pre-filter before fusing the two. With a corpus this small, lexical
search alone is often enough; fusing keeps recall high without introducing a
second datastore to operate.

`credibility` (0–100) weighs a peer-reviewed study above a forum post at fusion
time. `sourceId` and `sourceUrl` are what make citations possible.

---

## 8. `infrastructure` — 2 tables

### `fuel_stations`

Individual stations, kept because density has to be computed from something and
because a reviewer needs to be able to check a suspicious number. **The
recommendation engine never queries this table directly.**

### `infra_density`

The rollup the engine actually reads: station count, per-lakh-population rate,
percentile against every other city we hold, median distance to the nearest
station, and a `confidenceScore`.

The design decision here is deliberate honesty. Station-level data in India is
incomplete and goes stale fast, so the product does not promise "there are 47
chargers near you". It promises a density *band*, labelled indicative — which is
what a five-year purchase decision actually turns on. `confidenceScore` means a
low count from a thin source produces a low score rather than a confident false
negative that wrongly rules out an EV.

---

## 9. `users` — 9 tables

### Identity: `users`, `sessions`, `otp_codes`

Email plus OTP. Only hashes are stored for both session tokens and OTP codes, so
a database read cannot be replayed as a login. `users.defaultStateCode` and
`defaultCityId` let returning users skip questions.

### Runs: `recommendation_runs`, `e20_assessments`

Stored **whether or not the user is signed in.** Guest runs are keyed by
`anonymousId` and claimed on sign-in, so a user can complete the whole journey
before being asked for an email — which is the difference between a funnel that
converts and one that does not.

`recommendation_runs` stores the validated profile verbatim, the full ranked
`results` with score breakdowns, the `assumptions`, the `engineVersion` and the
latency. That makes a run reproducible and auditable long after the catalogue has
moved on. `profileBucket` is the bucketed key used for narrative cache lookup;
`narrativeFallback` records that the number-validation guard rejected the model
output and the deterministic template was served instead.

### Saved state: `saved_vehicles`, `reports`

`reports.shareToken` is an unguessable path segment with its own `expiresAt`,
independent of any session. `blobUrl` points at Vercel Blob.

### Signal: `feedback`, `llm_calls`

`feedback.disputedVariantId` records *which* recommendation the user disagreed
with — the fastest signal we get that the engine's weighting is wrong somewhere,
and far more actionable than a star rating.

`llm_calls` is per-call telemetry: purpose, model, input/output/cached tokens,
cost in micro-USD, latency, `cacheHit`, `guardRejected`, error. Unit economics
are the whole premise of this product, so they get measured rather than assumed.

---

## 10. `ingestion` — 6 tables

The pipeline, in order: `scrape_jobs` → `raw_documents` → `staging_records` →
`review_queue` → live catalogue, with `data_change_log` and `audit_log` recording
what happened.

- **`raw_documents` archives every fetched document before parsing**, with a
  content hash and a Blob URL. Any published fact can then be re-derived from the
  exact bytes it came from — the difference between an auditable catalogue and
  one we merely hope is right.
- **`staging_records`** holds parsed candidates with both `proposed` and
  `current` values, so the reviewer sees a diff rather than a payload.
  `validationFlags` carries range violations, cross-source disagreement and large
  deltas. `entityId` null means a proposed new row, matched by `matchKey`.
- **`review_queue`** — `pending` → `approved` / `rejected` / `auto_approved`.
  Nothing reaches the live catalogue without a recorded decision; auto-approval
  is a decision, not an absence of one.
- **`data_change_log`** is append-only: what changed, from what, to what, by
  whom, via which path (`manual`, `review_approval`, `seed_import`,
  `refresh_job`).
- **`audit_log`** covers actor actions generally, including admin operations that
  are not catalogue changes.

---

## 11. Indexing strategy

68 indexes excluding primary keys. They fall into five groups.

### 11.1 The candidate filter (the hot path)

```sql
vehicle_variants_candidate_idx
  ON (fuel_type, ex_showroom_paise, seating_capacity)
  WHERE status = 'active'
```

Stage 1 of the engine always narrows by fuel type and price, so this partial
index carries the request. Partial on `status = 'active'` because discontinued
variants are never candidates — that keeps the index small enough to stay hot.

`vehicle_variants_payload_idx` does the same job for the commercial branch,
partial on `status = 'active' AND payload_kg IS NOT NULL`.

`vehicle_variants_price_idx` on `ex_showroom_paise` (partial, active and
non-null) serves the queries the candidate index cannot: budget sliders and
"cheapest in segment", which do not pin a fuel type and so cannot use a leading
`fuel_type` column.

### 11.2 Trigram search — three indexes

Journey B opens with a hand-typed, frequently misspelled vehicle name. GIN
trigram indexes on `manufacturers.name`, `vehicle_models.name` and
`vehicle_variants.name` make similarity search fast; a b-tree cannot serve it at
all. This is what `pg_trgm` is installed for.

### 11.3 jsonb containment — five indexes

GIN indexes on the jsonb columns that are actually read by containment:
`vehicle_models.knownAdvantages`, `knownDisadvantages`, `commonProblems`,
`e20_guidance_rules.appliesToBodyTypes`, `e20_kb_chunks.tags`.

The guidance body-type narrowing runs on *every* E20 guidance lookup, so it
belongs in an index rather than in a post-filter. Without these, each containment
query is a sequential scan.

jsonb columns that are only ever read whole — `recommendation_runs.results`,
`staging_records.proposed`, `audit_log.detail` — deliberately have no GIN index.
An index nothing queries is write amplification with no reader.

### 11.4 Retrieval — two indexes

`e20_kb_fts_idx`, a GIN index over the `to_tsvector` expression, and
`e20_kb_embedding_idx`, HNSW with `vector_cosine_ops`. Both are needed because
retrieval fuses both scores.

### 11.5 Uniqueness and lookup

Slug keys on every public-facing table; natural keys on the dated reference
tables (`(segment, fuel_type, category, year, as_of)` and friends) so a refresh
cannot double-insert; `(state_code, category, fuel_type, price_band_min)` for
on-road lookup; `(status, scheduled_for)` for the job runner; `(purpose,
created_at)` for cost reporting.

Two partial unique indexes encode rules the application would otherwise have to
enforce: one current source per fact
(`fact_provenance_current_key`), and at most one variant-scoped compatibility row
per variant (`e20_compat_variant_key WHERE variant_id IS NOT NULL`).

### 11.6 What migration 0001 added

Eight GIN indexes — three trigram, five jsonb — plus one partial b-tree
(`vehicle_variants_price_idx`). `pg_trgm` had been installed in the baseline but
was unused until then.

---

## 12. Unenforced references

Some `uuid` columns reference another table conceptually but carry no foreign
key. This is deliberate in each case, and worth knowing before you assume
referential integrity you do not have:

| Column(s) | Why no FK |
|---|---|
| `*.sourceId` on `fuel_prices`, `maintenance_curves`, `resale_curves`, `battery_costs`, `emission_factors`, `fuel_stations` | Reference tables are bulk-refreshed; a restrictive FK would block a refresh whose source row is being replaced in the same run |
| `staging_records.entityId`, `data_change_log.entityId`, `audit_log.entityId`, `fact_provenance.entityId`, `data_quality.entityId` | Polymorphic — the target table is named in `entityTable` |
| `reports.runId`, `feedback.runId`, `llm_calls.runId`, `feedback.disputedVariantId` | Telemetry and artefacts outlive the rows they describe; a cascade here would destroy the audit trail |
| `users.defaultStateCode`, `users.defaultCityId`, `fuel_prices.cityId` | Convenience defaults; a stale value degrades to "ask the user again" |

Where an FK *does* exist, the delete behaviour is chosen rather than defaulted:
`restrict` for anything a fact depends on (`manufacturers`, `sources`),
`cascade` for owned children (variants under a model, sessions under a user),
`set null` for references whose loss should not delete the referrer.

---

## 13. Working with the schema

```bash
pnpm db:generate     # after editing src/db/schema/* — writes drizzle/NNNN_*.sql
pnpm db:migrate      # apply (needs DATABASE_URL)
pnpm db:verify       # post-migration sanity check against the live DB
pnpm db:validate     # data quality + coverage report
pnpm db:studio
```

**Regenerating the baseline?** Re-add the two `CREATE EXTENSION` statements at
the top of `drizzle/0000_init.sql`. drizzle-kit will not.

**Seeding is a diff, not a truncate-and-load.** Modules in
`src/db/seed/modules/` read what is already there and apply only the delta, and
never delete rows the seed no longer mentions — a seed file is a floor, not a
mirror, and mirroring would destroy curated data the moment someone trims a file.
The whole run shares one transaction, so a failure leaves nothing half-written.
`--dry-run` executes everything, reports real counts, then rolls back.

Catalogue, economics and E20 content do **not** arrive through the seed harness.
They come through the provenance-aware importer, which writes `fact_provenance`
rows alongside the facts themselves.
