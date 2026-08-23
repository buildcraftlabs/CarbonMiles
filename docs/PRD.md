# Carbon Miles — Product Requirements

Status: draft for MVP · Owner: product · Last reviewed: 2026-08-23

This is the contract the build is checked against. Every requirement below is
written so that it can be failed by a test or a demo. Where a number is a target
rather than a measured fact it says *target*.

Related: [ARCHITECTURE.md](./ARCHITECTURE.md) · [DATA-MODEL.md](./DATA-MODEL.md)

---

## 1. The problem

An Indian buyer choosing a vehicle in 2026 is choosing between five powertrains
whose economics diverge violently and whose relative merit depends on facts the
buyer does not have: what road tax their state charges, what their electricity
tariff actually is, whether there is a CNG pump on their route, what a battery
will cost in year eight. The advice available to them is either a spec sheet
(true but useless) or a review (readable but not about their situation).

Separately, the E20 petrol rollout has made every pre-2023 petrol owner in the
country uncertain about a fuel they cannot avoid buying, and the answers on the
internet range from "no effect" to "it will destroy your engine". Both are wrong
for most vehicles, and the correct answer is knowable per model.

Carbon Miles answers both questions from a curated database, arithmetic, and a
cited knowledge base — not from an LLM's recollection.

## 2. Who it is for

| Persona | What they arrive with | What they need |
|---|---|---|
| **First-car buyer** | A budget and a city | A shortlist that will not bankrupt them in year four |
| **Upgrade buyer** | A current vehicle and a running pattern | Whether the switch (usually to EV or CNG) actually pays back |
| **Small fleet / commercial buyer** | A route, a payload, a daily distance | ₹/km, payback month, ROI — not "which car is nicer" |
| **Existing petrol owner** | A vehicle they already own | A straight E20 answer and a maintenance plan |

Journey A serves the first three. Journey B serves the fourth. They share the
catalogue and nothing else.

## 3. Product principles

1. **Deterministic engine first. LLM last, and only for language.** Every number
   a user sees is computed in TypeScript or SQL. The model narrates; it does not
   decide, retrieve specifications, or arithmetise.
2. **No live web search at conversation time.** Facts are collected, reviewed and
   stored beforehand. This is what makes the product cheap, fast, reproducible
   and defensible.
3. **Never calculate from claimed figures.** ARAI efficiency and claimed range
   are display-only. Every calculation uses the real-world columns.
4. **Every fact carries provenance.** A number that cannot name its source does
   not reach a user.
5. **Show the assumptions.** A TCO figure without its assumptions is a guess with
   a decimal point. The assumptions panel is part of the result, not a footnote.
6. **Say "unknown" out loud.** An honest gap beats a confident fabrication, and
   the schema has an `unknown` verdict and a confidence level precisely so the
   product can use them.

## 4. Scope

### 4.1 Journey A — Vehicle Purchase Advisor

**In scope for MVP**

- A resumable, branching questionnaire that collects: category (passenger or
  commercial), budget, state and city, daily and monthly distance, typical trip
  length, city/highway split, passenger count, cargo or payload need, intended
  ownership duration, home-charging availability, financing preference, and
  environmental preference weight.
- Optional free-text entry parsed into the same structured profile by a
  strict-schema tool call, with the parsed profile shown back for confirmation.
- Deterministic filtering, economics, scoring and ranking (see
  [RECOMMENDATION-ENGINE.md](./RECOMMENDATION-ENGINE.md), to be written).
- A ranked result set of 3–5 vehicles with, per vehicle: on-road price, 5-year
  and horizon TCO, ₹/km, fuel/energy cost, maintenance, resale residual,
  break-even against the runner-up, well-to-wheel CO₂, and a sub-score breakdown.
- Commercial results additionally carry monthly margin, payback month and ROI.
- A side-by-side comparison of any two or three results.
- A narrative explaining *why* the top result won, streamed over the
  already-rendered deterministic result.
- A shareable PDF report.

**Out of scope for MVP**

- Live dealer inventory, on-road quotes, or booking.
- Insurance quotes from named insurers (we model insurance as a percentage).
- Used-vehicle recommendations.
- Loan pre-approval or lender integration.

### 4.2 Journey B — E20 Compatibility Advisor

**In scope for MVP**

- Vehicle selection by typed, misspelling-tolerant search over manufacturer,
  model and variant names, plus manufacture year and odometer.
- A deterministic verdict — `e20_compliant`, `e20_tolerant`, `e10_only`,
  `not_applicable`, `unknown` — from the compatibility table, scoped to variant
  where a variant-level row exists and to model otherwise.
- An expected efficiency-delta *range*, never a point estimate.
- A material risk level covering fuel lines, gaskets, seals and fuel-contact
  aluminium.
- Deterministically selected guidance rows: inspections, service intervals,
  driving habits, component upgrades, fuel practices.
- Prose over those rows, generated from retrieved knowledge-base chunks, with
  citations to their sources.
- Explicit labelling when a verdict is inferred from the emission norm rather
  than an OEM statement.

**Out of scope for MVP**

- Any recommendation to modify a vehicle in a way that voids a warranty.
- Fuel-station-level ethanol blend reporting.
- VIN decoding.

### 4.3 Cross-cutting, MVP

- Email + OTP authentication. Guest users complete a whole journey before being
  asked for an email; guest runs are claimed on sign-in.
- Saved vehicles, saved reports, recommendation history.
- PWA: installable, mobile-first, works on tablet and desktop.
- Admin portal: variant CRUD, review queue with diff view, recommendation logs.

### 4.4 Deferred

| Item | Phase |
|---|---|
| Social login | 2 |
| Automated ingestion pipeline running on a schedule | 2 |
| Two- and three-wheeler catalogue depth beyond the seed set | 2 |
| Hydrogen vehicles (enum and station type exist; no data) | 3 |
| Upcoming/unreleased model coverage | 3 |
| Regional languages | 3 |
| Fleet accounts with multiple vehicles and aggregate reporting | 3 |

## 5. Functional requirements

Numbered so tests can cite them.

### Journey A

- **FR-A1** The questionnaire must be resumable: a user who leaves mid-way and
  returns within the session window resumes at the question they left.
- **FR-A2** The profile must validate against a zod schema before the engine
  runs. An invalid profile returns a field-level error, never a partial result.
- **FR-A3** Hard filters must exclude any variant outside the budget ceiling
  (on-road, not ex-showroom), below the required seating capacity, or below the
  required payload.
- **FR-A4** A fuel feasibility gate must exclude a powertrain the user cannot
  practically run — an EV with no home charging in a city whose DC density
  confidence is low, a CNG vehicle where the CNG density band is bottom-decile.
  Exclusions must be reported, with their reason, not silently applied.
- **FR-A5** On-road price must be computed from the user's state, using road tax,
  registration, insurance and levies for that state, price band and fuel.
- **FR-A6** TCO must cover the user's stated ownership duration and include
  acquisition, fuel/energy, maintenance, insurance renewals, financing interest
  where financing is selected, probability-weighted battery replacement for EVs,
  and resale residual as a credit.
- **FR-A7** Every economics figure must derive from `realWorldEfficiency*` /
  `realWorldRangeKm`. A test must fail if `claimedEfficiency` or
  `claimedRangeKm` appears in any engine calculation path.
- **FR-A8** Results must be diversified: no more than two variants of the same
  model, and at least two distinct fuel types where feasible ones exist.
- **FR-A9** Every result must carry a complete explainability payload — every
  input, intermediate and weight that produced its score.
- **FR-A10** The deterministic result must render before the narrative starts
  streaming. The page must be useful with the narrative disabled.
- **FR-A11** Every displayed number must appear in the API response's `data`,
  with its `assumptions` and `sources` alongside.
- **FR-A12** A run must be reproducible: the stored run records the profile, the
  engine version, and the full ranked score breakdown.

### Journey B

- **FR-B1** Vehicle search must return sensible results for a misspelled query
  (trigram similarity, not exact prefix match).
- **FR-B2** The verdict must come from the compatibility table. Variant-scoped
  rows take precedence over model-scoped rows.
- **FR-B3** Where a compatibility row's `appliesFrom`/`appliesTo` window excludes
  the user's manufacture year, that row must not be used.
- **FR-B4** A verdict with `inferredFromNorm = true` must be labelled to the user
  as inferred from the emission norm, not presented as an OEM position.
- **FR-B5** Where no compatibility data exists, the verdict is `unknown` and the
  UI says so. It must not fall back to a guess.
- **FR-B6** The mileage delta must be presented as a range, with both bounds.
- **FR-B7** Guidance rows must be selected by verdict, risk level, body type and
  year — deterministically. The LLM phrases them; it does not choose them.
- **FR-B8** Every guidance claim in the narrative must carry a citation resolving
  to a `sources` row.
- **FR-B9** The advisor must never contradict a published OEM position held in
  `oemStatementSummary`.

### AI boundary

- **FR-X1** Model output must be validated against the payload it was given. A
  number in the output absent from the input payload fails the response.
- **FR-X2** On guard rejection, a deterministic template is served instead, and
  the run is marked `narrativeFallback = true`.
- **FR-X3** Every LLM call must write an `llm_calls` row with token counts,
  cost in micro-USD, latency, cache-hit flag and guard-rejection flag.
- **FR-X4** No engine path may issue a network call to anything other than the
  database and the AI gateway. No live web search, ever.

### Accounts and persistence

- **FR-U1** A guest must be able to complete either journey end-to-end without
  signing in.
- **FR-U2** On sign-in, guest runs matching the anonymous id are claimed by the
  user.
- **FR-U3** OTP codes are stored hashed. A database read must not be replayable
  as a login.
- **FR-U4** A shared report link must be unguessable and independently revocable.

## 6. Non-functional requirements

Targets, to be measured in Epic 9.

| Dimension | Target |
|---|---|
| Registered users supported | 100,000 |
| Recommendation requests | 1,000,000 cumulative |
| Deterministic result (p95, warm) | ≤ 800 ms server time |
| First narrative token (p95) | ≤ 1.5 s after the deterministic result |
| Journey B assessment (p95) | ≤ 600 ms for the verdict, guidance streamed after |
| LLM cost per recommendation | ≤ US$0.002 amortised, including cache hits |
| Narrative cache hit rate | ≥ 60% at steady state |
| Guard rejection rate | ≤ 2% (higher means the prompt is wrong) |
| Availability | 99.5% monthly |
| Lighthouse performance, mobile | ≥ 90 |
| Installability | Passes PWA installability audit |

Cost discipline is a product requirement, not an ops concern: the whole
architecture exists to keep the marginal cost of a recommendation near zero, and
`llm_calls` exists so that claim is measured rather than assumed.

## 7. Data requirements

- MVP catalogue: ~150 passenger ICE variants, ~60 EV/hybrid/CNG variants, ~50
  two- and three-wheeler variants, plus a commercial set sufficient to make
  Journey A's commercial branch real.
- Economics reference tables must be populated for every state the product
  offers, not just metros: on-road factors, fuel prices, electricity tariffs,
  maintenance and resale curves, battery costs, finance rates, emission factors.
- E20 compatibility must be sourced from OEM statements where they exist, and
  from the BS-VI phase 2 rule only where they do not — with the inference
  flagged.
- Every fact-bearing column gets a `fact_provenance` row.

See [DATA-SOURCING.md](./DATA-SOURCING.md) (to be written) for acquisition,
ranking, validation and refresh.

## 8. Compliance and liability

- **Advice, not certification.** The product must not state or imply that it
  certifies a vehicle as E20-safe. Verdicts are reported with their source and
  confidence, and the OEM position is authoritative wherever it exists.
- **No safety-critical instruction.** Guidance covers inspection and maintenance
  practice; it does not instruct users to perform modifications.
- **Crawl boundary in code.** The ingestion pipeline must refuse to fetch a
  source whose terms forbid it. This is enforced by `sources.crawlAllowed`, not
  by policy documents.
- **Personal data minimisation.** We store an email, a state, a city and the
  user's own runs. No location tracking, no contact upload, no ad identifiers.
- **Prices are indicative.** On-road figures are modelled, dated, and labelled as
  such. Every money figure carries its `asOf`.

## 9. Success metrics

| Metric | Why it matters | MVP bar |
|---|---|---|
| Questionnaire completion rate | The funnel dies here or nowhere | ≥ 60% |
| Result → comparison rate | Signals the shortlist is plausible | ≥ 35% |
| Report download or share | Signals the output is worth keeping | ≥ 20% |
| Journey B assessments per week | Demand for the second product | measured, no bar |
| Disputed recommendations (`feedback.disputedVariantId`) | Fastest signal the weighting is wrong | ≤ 5% of rated runs |
| Median LLM cost per run | The premise of the architecture | ≤ US$0.002 |

## 10. Release scope

**MVP (Epics 0–6, 9).** Both journeys, curated seed catalogue, deterministic
engine, Haiku narration with the guard, PWA, auth, reports, hardening.

**Phase 2 (Epics 7–8).** Admin portal in anger, automated ingestion and refresh
running on a schedule, catalogue depth, social login.

**Phase 3.** Hydrogen, upcoming models, regional languages, fleet accounts,
dealer and financing integrations.

## 11. Open questions

1. What ownership horizon do we default to when the user says "not sure" — five
   years, or the segment-median holding period?
2. Do commercial users get a separate entry point, or a branch inside the same
   questionnaire? (Currently modelled as a branch.)
3. How do we present a `low` confidence verdict in Journey B without either
   alarming the user or being useless?
4. Does the narrative cache key on the bucketed profile alone, or on bucketed
   profile plus the ranked variant id set? The latter is safer and colder.
