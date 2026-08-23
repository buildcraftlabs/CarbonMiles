# Recommendation engine

How Journey A turns a profile into a ranked list, and why each number is the
number it is.

This document is written against the code in `src/lib/engine/`. Where the two
disagree, the code is right and this file is stale — but the *conventions* are
exported as data (`TCO_CONVENTIONS`, `CO2_CONVENTIONS`, `COMMERCIAL_CONVENTIONS`,
`SCORING_CONVENTIONS`, `GATE_THRESHOLDS`, `FIT_PARAMETERS`, `BASE_WEIGHTS`)
precisely so that the explainability payload can state them at runtime rather
than relying on a document staying in step.

## 0. The rule that shapes everything

> Deterministic engine first. LLM last, and only for language.

Stages 1–5 are pure functions. No database access, no clock, no network, no
model. Every date arrives as an `asOf` string parameter rather than being read
from the system clock, which is what lets a stored run replay to the same
numbers years later (FR-A12).

`src/lib/engine/` never imports `src/db/`. The query layer projects rows into
plain data types (`CandidateVariant`, `EconomicsTables`, `EmissionFactor`, …)
and the engine runs unchanged against fixtures. That is why the whole thing is
testable without a database, and why 270 tests run in under a second.

## 1. Two kinds of number

The single most important distinction in this engine:

| | Sourced facts | Modelling conventions |
|---|---|---|
| Examples | Petrol 2.31 kg CO₂e/l, road tax 11% in MH, a resale curve's residual % | Whether biogenic carbon counts, how far a battery-replacement probability tapers, how much a surplus seat costs a fit score |
| Where they live | Postgres, with a `fact_provenance` row | Exported `const` objects in the engine, named `*_CONVENTIONS` or `*_PARAMETERS` |
| Change by | Re-seeding, with a new `asOf` | A code change, with a test around it |
| In the payload | `sources` | `assumptions` |

A sourced fact must never be hardcoded in the engine. Petrol at 2.31 kg/l looks
stable enough to inline; the grid factor next to it moves every year and varies
by state by more than it varies year on year, and hardcoding *either* teaches
the next person that inlining is fine. Both are seed values for
`emission_factors`, carrying a `sourceId`, an `asOf` and an optional
`stateCode`.

A convention must never be silently applied. If we decide something the
evidence does not decide for us, the decision is named, exported, and surfaced.

## 2. Stage 1 — hard filters and feasibility gates

`src/lib/engine/stage1.ts`, `src/lib/engine/on-road.ts`

### 2.1 On-road price

Budget is compared against **on-road** price, never ex-showroom (FR-A5). Road
tax alone runs from roughly 6% to 20% by state, price band and fuel, so
filtering on ex-showroom admits vehicles the buyer cannot afford.

```
onRoad = exShowroom
       + exShowroom × roadTaxPct/100
       + registrationFee
       + exShowroom × insurancePct/100
       + otherLevy            (negative for a rebate — EV subsidies land here)
```

Rows of `state_on_road_factors` legitimately overlap: a state-wide default, an
EV carve-out, and a newer revision of both. Selection is ordered, not assumed
unique — **a fuel-specific row beats a fuel-agnostic one, then the most
recently effective row wins**. No applicable row means *cannot price*, which is
an exclusion, never a silent assumption of zero tax.

### 2.2 Hard filters (FR-A3)

Applied in this order, first failing test wins, one reason reported per
variant. Ordered cheapest and most fundamental first; pricing runs last because
it is the only step that searches a table.

`not_active` → `wrong_category` → `body_type_wrong_category` →
`fuel_excluded_by_user` → `unavailable_in_state` → `seating_below_requirement` /
`payload_below_requirement` → `price_unknown` / `on_road_price_unknown` →
`above_budget` / `below_budget_floor`

Telling a buyer their ₹6L hatchback budget rules out a bus adds nothing once
they have been told a bus is not a passenger vehicle.

### 2.3 Feasibility gates (FR-A4)

A powertrain the user cannot practically run is excluded — **with its reason**,
never silently.

| Constant | Value | What it means |
|---|---|---|
| `networkPercentileFloor` | 10 | Bottom decile of national density, or no stations at all. Below this a refuelling detour stops being incidental and starts shaping every trip. |
| `evDcConfidenceFloor` | 40 | Below this we hold too little evidence to promise a buyer with no home charging that they can live with an EV. |
| `evRangeUtilisation` | 0.8 | Share of real-world range usable between charges. The 20% headroom absorbs degradation over the horizon, winter and traffic losses, and the reserve nobody drives down to. |

Only CNG and hydrogen are network-gated. Petrol and diesel are ubiquitous
enough that a gate would only ever fire on missing data. LPG has no
`station_type` member at all, so it is never gated — *and* never credited (see
§4.4).

The binding distance for the EV range gate is `max(dailyKm, typicalTripKm)`: a
long daily total and a long single trip both force the same public stop.

**Where a gate cannot be tested, that is recorded as an assumption, not treated
as a pass.**

## 3. Stage 2 — economics

`src/lib/engine/tco.ts`, `commercial.ts`, `co2.ts`

### 3.1 The rule that governs every figure here

Every economics figure derives from `realWorldEfficiency*` / `realWorldRangeKm`
(FR-A7). `claimedEfficiency` and `claimedRangeKm` exist for display only.

This is enforced **structurally**, not by care: the types the calculations are
written against (`VariantEconomics`, `VariantEmissions`, `CandidateVariant`)
have no claimed-figure fields, so there is no path by which an ARAI number
could reach the arithmetic.

### 3.2 Blended efficiency

City and highway figures differ by 20% or more — wider than the gap between
many rival variants — so the split matters more than it looks.

```
efficiency = city × citySharePct/100 + highway × (1 − citySharePct/100)
```

Where only one figure is published it is used for the whole distance, and that
substitution is recorded as an assumption rather than the variant being
discarded.

### 3.3 TCO (FR-A6)

Money is **paise, as integers**, everywhere. A ₹50L ex-showroom price is
5×10⁹ paise — past int32 — and float rupees drift once compounded across a
ten-year horizon.

Legs: acquisition (on-road plus any loan processing fee) + energy + maintenance
+ insurance renewals + financing interest + probability-weighted battery
replacement − resale credit.

```
costPaisePerKm = totalPaise / totalKm
```

| Convention | Value | Why |
|---|---|---|
| `batteryReplacementTaperYears` | 2 | The chance the *owner* pays for a replacement tapers to zero as the crossing point nears the end of the hold. An owner whose battery hits the threshold two months before they sell does not replace it; they sell. |
| `priceEscalationPct` | 0 | We hold no sourced escalation curve. Inventing one moves every candidate the same direction — it changes the totals without changing the order. |
| `discountRatePct` | from `EconomicsTables` | Applied to the **resale credit only**. Resale is the one large flow landing entirely at the far end of the horizon, so counting it at face value overstates how much it offsets. Running costs accrue evenly and are quoted nominally, because that is the number a buyer plans against. |

`breakEvenMonth` compares one vehicle's cumulative spend against another's,
spreading each year's figure evenly across its months.

### 3.4 Commercial economics

Only for `category: "commercial"`. Three scenarios — `low`, `base`, `high` —
over freight rate and driver cost.

```
operatingCost   = recurringCost + driverCost      (recurringCost = Σ tco.yearly[].total)
operatingMargin = grossRevenue − operatingCost    (before capital)
netProfit       = grossRevenue − (tco.total + driverCost)
netMarginPaisePerKm = netProfit / totalKm
roiPct          = netProfit / capital × 100       (capital = tco.acquisition)
```

`tco.totalPaise` already carries acquisition and already nets off the resale
credit, so adding the driver is the whole of what the TCO does not cover. The
cost curve payback races against is literally the one that costed the vehicle —
reused rather than re-derived, so the two cannot drift apart.

| Convention | Why |
|---|---|
| `paybackExcludesResale` | Payback races the vehicle against its own accruing revenue. Crediting a residual the operator has not sold yet would show a payback that has not happened. |
| `bandPairsInputsAdversely` | The low case pairs the worst rate with the worst driver cost, the high case the best with the best. Varying one at a time understates the spread — a bad year is not a year in which only one input moves against you. |

`paybackMonth: null` means *it never pays back inside the horizon*. That is a
real answer and arguably the most useful one the module produces.

`DEFAULT_SENSITIVITY_BY_DUTY_CYCLE` is **our convention, not sourced rates** —
deliberately wide, encoding one defensible observation: rate volatility rises
from contracted last-mile (±10%) toward spot intercity freight (±25%), and
driver pay moves less than freight rates do because wages are sticky and
freight is not. A caller holding real contracted rates should pass their own
range and get a tighter, better answer.

### 3.5 Well-to-wheel CO₂

```
gramsCo2ePerKm = appliedGramsCo2ePerUnit / effectiveEfficiency
```

Same shape as TCO's arithmetic, deliberately: same real-world efficiency, same
blend function. If the two stages ever disagreed about how far a litre goes,
the ₹/km and the g/km on the same result card would contradict each other.

| Convention | Value | Why |
|---|---|---|
| `countBiogenicCarbon` | `false` | The CO₂ from burning the ethanol fraction was taken out of the atmosphere last season. Reported *beside* the total, never inside it — IPCC and GHG Protocol treatment. Cultivation, fertiliser, transport and distillation are fossil and **are** counted. |
| `chargingLossPct` | 0 | The grid factor applies to the kWh the vehicle turns into distance. TCO prices energy on the same basis; a CO₂ figure computed off a different number of kWh than the cost figure would be indefensible side by side. |
| `factorDriftPctPerYear` | 0 | The grid factor is held flat. India's grid is decarbonising, so an EV's ten-year figure is conservative — the error runs *against* the EV, the safe direction for a claim we cannot source. |
| `includesEmbodiedEmissions` | `false` | Well-to-wheel is the fuel cycle. Pack manufacture is cradle-to-gate: a different boundary on far shakier evidence, and mixing them makes the number comparable to nothing. |

Ethanol blends do two separate things, and conflating them is easy: efficiency
falls (the per-vehicle penalty is *sourced*, from
`e20_compatibility.mileageDeltaMin/MaxPct` — this module does not invent it),
and the carbon changes character. A `Co2Input` with no `blend` is treated as
neat fossil petrol; assuming every petrol vehicle in the country runs E20 would
be a fabrication in exactly the place the product claims to be careful.

### 3.6 Failure is typed, never guessed

Every stage-2 module returns a discriminated union. A variant that cannot be
assessed comes back as `{ ok: false, code, reason }` — `efficiency_missing`,
`emission_factor_missing`, `resale_curve_missing`, and so on.

**A wrong number is worse than a missing one, because a wrong number ranks.**

## 4. Stage 3 — sub-scores and persona weighting

`src/lib/engine/stage3.ts`

Stage 2 produces figures in incompatible units: rupees over a horizon, grams
per kilometre, months to payback, a count of service centres. They cannot be
added.

### 4.1 Normalisation

Min–max **across the candidate set**, not against an absolute scale:

```
higher_is_better:  100 × (raw − min) / (max − min)
lower_is_better:   100 × (max − raw) / (max − min)
```

There is no defensible absolute. A ₹12L five-year TCO is excellent for a
seven-seater and poor for a hatchback, and the only honest reading of "cheap"
is *cheap among the vehicles this buyer can actually buy*. Stage 1 has already
bounded the set by the user's own budget, which is what keeps the range from
being set by an outlier nobody was ever going to buy.

The consequence has to be stated plainly: **the scores are not portable.** The
same vehicle scored against a different candidate set gets a different number.
They rank; they do not grade. Every sub-score carries the `range` it was
measured against so the payload can say so.

### 4.2 The dimensions

| Dimension | Raw figure | Direction | Category |
|---|---|---|---|
| `cost` | `tco.totalPaise` | lower | passenger only |
| `profitability` | `commercial.base.netMarginPaisePerKm` | higher | commercial only |
| `payback` | `commercial.base.paybackMonth` | lower | commercial only |
| `usage` | capacity fit, averaged with range headroom for EVs | higher | both |
| `infrastructure` | access index | higher | both |
| `environment` | `co2.gramsCo2ePerKm` | lower | both |
| `reliability` | `manufacturers.serviceCentreCount` | higher | both |
| `resale` | `resale_curves.liquidityScore` | higher | both |

**A commercial profile scores profitability and payback but not cost.** Net
margin per km is `revenue/km − driver/km − TCO/km`, and the first two terms are
constants of the profile — so a normalised profitability score is the *exact*
mirror of a normalised cost score. Scoring both would give one signal two
weights wearing different names. Payback survives the same test because it
turns on the *shape* of the cost curve against accruing revenue, not just its
total, and does order candidates differently.

**Environment normalises the counted figure only.** `biogenicGramsCo2PerKm` is
not folded in, so `CO2_CONVENTIONS.countBiogenicCarbon` holds at the one place
where reversing it would change a ranking.

**A vehicle that never pays back** is scored one month past the horizon: below
everything that does pay back, without the normalisation having to handle an
infinity.

### 4.3 Fit indices (`FIT_PARAMETERS`)

Two dimensions are composites rather than a single measured quantity. Their
shape parameters are conventions, exported so the payload can cite the number
that shaped a score.

*Capacity fit.* Stage 1 has already removed everything too small, so this only
ever measures **surplus** — paid in price, fuel and parking, every day, by
someone who did not want it. 8 points per surplus seat, 40 points per 1.0 of
surplus payload ratio, floored at 40. Bigger than you need is a compromise, not
a disqualification.

*Range headroom*, electric only. Measured against the same
`max(dailyKm, typicalTripKm)` and the same `evRangeUtilisation` the stage-1
gate used, so a vehicle that only just cleared the gate cannot then score as if
range were comfortable. Usable range at 2× the distance between charges scores
100; exactly 1× scores 40.

Range is scored under *usage*, not infrastructure, and only for EVs: a petrol
tank's range is not a constraint on how the vehicle can be used — the pump
network is, and that is what the infrastructure sub-score already measures.

### 4.4 Infrastructure access

A density percentile is pulled toward the neutral midpoint in proportion to how
thinly it is evidenced:

```
access = 50 + (percentile − 50) × confidenceScore/100
```

A bottom-decile reading we barely trust should not sink a vehicle, and a
top-decile reading we barely trust should not float one. Same instinct as
stage 1's confidence floor, applied continuously instead of as a gate.

- **Home charging** puts a floor of 85 under an EV. A vehicle that leaves full
  every morning is not living off the public network.
- **Petrol, diesel, hybrids and flex-fuel** score 95 when no reading exists —
  high, but not 100: it is an absence of evidence, not evidence of a pump.
- **LPG scores nothing at all.** It is ungated in stage 1 and uncredited here,
  for the same reason: LPG retail is not tracked, and "we have no data" is not
  the claim "there is a pump on every corner".

### 4.5 Weights

Two inputs and no more: the category, which decides *which* dimensions exist,
and `preferences.environmentWeight`, which decides how loudly CO₂ speaks
against money. Everything else in the profile has already had its say — it
shaped the TCO, the gates and the fit indices, and letting it move the weights
as well would count it twice.

```
environmentWeight_raw = preferences.environmentWeight × moneyWeight
```

…where `moneyWeight` is the `cost` weight for a passenger profile and
`profitability + payback` for a commercial one. This is exactly what the
preference is documented to mean: 0 decides on money alone, 1 weights CO₂ as
heavily as cost. At 0 the dimension is dropped entirely rather than scored at
zero weight. All weights are then renormalised to sum to 1.

`BASE_WEIGHTS` is **a starting position, not a finding.**
`feedback.disputedVariantId` is the metric that tells us it is wrong (target:
≤5% of rated runs), and the numbers live in an exported table so that moving
them is a one-line change with a test around it rather than an archaeology
exercise.

### 4.6 Missing data is never imputed

A candidate with no service-centre count scores `null` on reliability and has
that dimension's weight **redistributed proportionally across the dimensions it
can be scored on** — rather than being handed a middling 50 that would rank it
against vehicles we actually know something about. Two otherwise-identical
vehicles, one with a data gap, score identically.

Where every candidate ties on a dimension, it cannot order them: all score 50,
flagged `discriminating: false`. This is why **a lone survivor totals 50, not
100** — with nothing to compare against, a relative score is meaningless, and
saying so is better than printing a confident 100.

Scores round to 2 decimal places, weights to 4. At 2, a 9.5% environment weight
becomes 10% and the claim that it is a quarter of the cost weight stops being
checkable from the payload.

## 5. Stage 4 — diversification and ranking

`src/lib/engine/stage4.ts`

Sorting stage 3's scores and taking the top five is one line, and it produces a
bad result set: variants of one model differ by a sunroof and score within a
point of each other, so an unconstrained top five is routinely the same car
five times. A buyer learns nothing from that.

| Constraint | Value | Why |
|---|---|---|
| `MAX_VARIANTS_PER_MODEL` | 2 | Typically the sensible trim and the one a rung up. A third adds a price point, not a decision. |
| `MIN_DISTINCT_FUELS` | 2 | The whole product is a claim about which powertrain suits a buyer. Answering with five petrol hatchbacks when a feasible EV was two points behind hides the decision the user came to make. Enforced **only where the pool holds a second fuel** — inventing diversity that survived no gate would be worse than admitting there is one sensible answer. |
| `DEFAULT_RESULT_LIMIT` | 5 | The PRD promises 3–5. Five is the ceiling; the floor is however many survived, because padding a short list means recommending something the filters had already judged unsuitable. |

Neither constraint may cost the **top pick**. The highest scorer is always
rank 1; diversification rearranges what sits behind it. The fuel correction is
a single swap rather than a re-solve under a diversity constraint, because
re-solving changes the top of the list to fix the bottom of it — and the top of
the list is the answer.

Ties break on `variantId`, not name. The tie-break is arbitrary and that is the
point: it has to be *stable*, or a stored run replays into a different order
than the one the user was shown. Sorting on a name would reorder the moment a
catalogue edit fixed a typo.

Every candidate is accounted for exactly once across `ranked` and `omitted`,
with a code — `model_cap`, `displaced_for_fuel_diversity`, or `outscored`. A
result set that quietly dropped a better-scoring vehicle is not explainable.

## 6. The explainability framework

Every API response is `{ data, assumptions, sources }`. A number never reaches
a user unattributed (FR-A11).

**`data`** — every input, intermediate and weight that produced each score
(FR-A9). Concretely, the payload can reconstruct the whole chain: the
`OnRoadPrice` with the `state_on_road_factors` row that produced it; the
`TcoBreakdown` with its yearly series; the `Co2Breakdown` with the
`EmissionFactor` row, the effective efficiency and the applied per-unit figure,
so the division can be re-done by hand; each `SubScore` with its `raw`, `unit`,
`direction`, `range`, `weight` and `discriminating` flag; the persona `weights`
and the `weightBasis` prose; the `rank`, `selectedBy` and `bestInFuel` flags;
and every `Exclusion` and `Omission` with a finished-sentence reason.

**`assumptions`** — every convention applied and every gap papered over.
Written as finished sentences at the point the substitution happens, so they
are usable as-is by the UI *and* as the deterministic fallback when the
narrative model is unavailable.

**`sources`** — the `fact_provenance` rows behind the sourced facts.

### 6.1 The guard

Only after all of the above is computed and rendered does Haiku narrate, and it
is shown **nothing but this payload**. Anything the model emits is validated
against it: **a number in the output that is absent from the input payload
fails the response and falls back to a deterministic template**
(`narrativeFallback = true`).

Preserve this guard. It is what makes the product both cheap and defensible.
The page is useful with the narrative disabled (FR-A10), which is a resilience
property and a cost lever at the same time.

## 7. Changing the engine

- **Move a constant, not a literal.** If you find yourself typing a number into
  a formula, it belongs in an exported `*_CONVENTIONS` / `*_PARAMETERS` object
  with a comment saying why — or in Postgres with a `fact_provenance` row.
- **Weights and thresholds need a test that pins the *reason*, not just the
  value.** `expect(weights.environment).toBeCloseTo(weights.cost)` at a
  preference of 1 survives a retune; `expect(weights.cost).toBe(0.38)` does
  not, and does not say anything either.
- **Anything that changes a ranking is an engine version bump.**
  `recommendation_runs` stores the engine version alongside the profile and the
  full ranked breakdown so old runs remain interpretable, and the narrative
  cache is keyed on it.
- **Test against fixtures, not the database.** The engine is pure so that it
  can be; keeping it pure is a design constraint, not a convenience.

## Related

- `docs/ARCHITECTURE.md` — request flow, caching, retrieval
- `docs/DATA-MODEL.md` — the tables behind every figure here
- `docs/PRD.md` — the FR-A requirements this engine implements
