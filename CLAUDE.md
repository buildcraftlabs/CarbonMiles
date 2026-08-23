# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:ca08a54f -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd dolt push
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->


## What this is

Carbon Miles is a mobility-intelligence PWA for the Indian market with two products:

- **Journey A — Vehicle Purchase Advisor**: recommends a vehicle (passenger *and* commercial)
  from usage, budget, location, infrastructure availability and total cost of ownership, and
  explains why.
- **Journey B — E20 Compatibility Advisor**: assesses a vehicle the user already owns for E20
  petrol compliance, efficiency impact and wear risk, with evidence-backed maintenance guidance.

`Carbon Miles.md` at the repo root is the original product brief.

## Commands

```bash
pnpm dev                       # next dev
pnpm build                     # next build (runs tsc as part of the build)
pnpm typecheck                 # tsc --noEmit
pnpm lint                      # eslint
pnpm test                      # vitest run
pnpm test -- path/to/file.test.ts        # single file
pnpm test -- -t "name of the test"       # single test by name
pnpm db:generate               # drizzle-kit generate (after editing src/db/schema/*)
pnpm db:migrate                # apply migrations (needs DATABASE_URL)
pnpm db:studio                 # drizzle-kit studio
pnpm db:seed                   # seed the catalogue and reference tables
pnpm db:validate               # data quality + coverage report
```

`DATABASE_URL` comes from Neon via the Vercel Marketplace: `vercel env pull .env.local`.
Provisioning needs Vercel CLI ≥ 59 — older versions have no `--yes` on `vercel integration add`
and cannot be driven non-interactively.

## Architecture: the one rule that shapes everything

> **Deterministic engine first. LLM last, and only for language.**

The product deliberately does **no live web search at conversation time**. All vehicle facts come
from Postgres. Claude Haiku only turns already-computed numbers into prose.

| Job | Who does it |
|---|---|
| Filter candidates, compute TCO/ROI/CO₂, score, rank, compare | TypeScript + SQL. No LLM. |
| Narrate a scored result set | Haiku, from the explainability payload only |
| Parse free text into a structured profile | Haiku, strict-schema tool call |
| E20 verdict, mileage-delta range, risk level | Rules table + compatibility data. No LLM. |
| E20 guidance prose | Haiku over retrieved KB chunks, with citations |

Anything the model emits is validated against the payload it was given: a number in the output
that is absent from the input payload fails the response and falls back to a deterministic
template. Preserve this guard — it is what makes the product both cheap and defensible.

### Request flow (Journey A)

profile → hard filters + fuel feasibility gates → per-variant economics (TCO, ₹/km, break-even;
commercial adds margin/payback/ROI) → normalised sub-scores with persona-derived weights →
diversify and rank → explainability payload → *only then* Haiku narrates, streamed over an
already-rendered deterministic result.

### Layout

- `src/db/schema/` — nine modules, 38 tables. `catalogue` (the workhorse `vehicle_variants`),
  `economics` (the reference tables that make TCO real), `e20`, `infrastructure`, `users`
  (includes `recommendation_runs` and `llm_calls`), `ingestion`, `sources`, `geography`, `enums`.
- `src/db/client.ts` — module-scoped pool. Correct under Fluid Compute, which reuses instances
  across concurrent requests.
- `drizzle/` — generated migrations.
- `docs/` — PRD, architecture, data model, data sourcing, AI architecture, API, flows,
  recommendation engine, roadmap, risks.
- Engine code belongs in `src/lib/engine/` as pure functions with no database access, so it can
  be tested against golden fixtures.

## Conventions and gotchas

- **Money is paise, stored as `bigint`.** A ₹50L ex-showroom price is 5×10⁹ paise, past int32,
  and float rupees drift once compounded across a ten-year horizon.
- **Never calculate from claimed figures.** `claimedEfficiency` / `claimedRangeKm` exist for
  display; every calculation uses `realWorldEfficiency*` / `realWorldRangeKm`. ARAI numbers
  overstate real economy and would bias every recommendation.
- **Every fact needs provenance.** New fact-bearing columns get a `fact_provenance` row
  (`entityTable`, `entityId`, `field`, `sourceId`, `confidence`, `verifiedAt`). API responses
  carry `{ data, assumptions, sources }` — a number never reaches a user unattributed.
- **Drizzle uses `casing: "snake_case"`** in both `drizzle.config.ts` and the client, so columns
  are declared without explicit SQL names. Keep both in sync or generated SQL will drift.
- **`CREATE EXTENSION` is hand-added.** drizzle-kit does not emit it; `vector` and `pg_trgm` are
  prepended to `drizzle/0000_init.sql`. Re-check after regenerating a baseline migration.
- **RAG is confined to `e20_kb_chunks`.** Vehicle specifications must come from the catalogue
  tables, never from retrieval.
- **This is Next.js 16.** `AGENTS.md` carries a framework-authored block instructing you to read
  `node_modules/next/dist/docs/` before writing framework code — its APIs and conventions differ
  from older training data. Do that rather than working from memory.
- **bd dependency quirk:** an epic cannot be blocked by a task ("epics can only block other
  epics"). Cross-epic ordering is expressed epic-to-epic; fine-grained ordering lives on tasks.

@AGENTS.md
