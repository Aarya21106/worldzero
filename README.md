# WORLDZERO

**One world. Infinite possibilities.** — an autonomous civilisation simulation engine controlled by natural language (GOD MODE).
Everything in it is fictional, synthetic data.

## Run

```bash
npm install
npm start          # builds the UI and starts the server on http://localhost:4000
```

`npm run dev` runs the server plus Vite hot-reload on http://localhost:5173. `npm test` runs the acceptance tests.

The world is generated once (≈15,000 citizens, ≈6,500 households, ≈960 organisations and ≈980 buildings across 36 districts
split by a river) and then persists in `data/worldzero-v4.db`. Delete that file to found a new civilisation.
`WORLD_SEED=123` picks the seed and `WORLD_POPULATION=25000` changes the size of a newly founded world: organisation counts,
migration, construction and default event sizes all scale with it.

## Version 2

- Population tripled to ~15,000 (simulates at ~1.7 ms per day; a year in about 0.6 s).
- 6×6 district map with a river and bridges, cross streets inside every district, lane-marked avenues and street trees.
- Building form follows kind and neighbourhood wealth: brick blocks, mid-rise apartments, villas with pitched roofs, glass
  podium towers that rise toward the centre, factories with chimneys.
- Lit windows show real occupancy (homes) and staffing (workplaces); vacant buildings go dark.
- Traffic: a sample of real employed commuters drive their actual home→work routes. Cars and pedestrians stop when the
  simulation is paused.
- Day / night lighting toggle (visual only).

## GOD MODE interpreter

`Natural language → interpreter → typed plan → validator → simulation engine → persistent state → 3D city → report`

- **AI interpreter (recommended):** create a `.env` file in the project root (or set environment variables) with
  `ANTHROPIC_API_KEY=...`, or `OPENAI_API_KEY=...` plus optional `OPENAI_BASE_URL`. Optional: `LLM_MODEL`, `PORT`.
  `LLM_PROVIDER=claude-cli` uses a locally installed `claude` CLI instead of an API key. Keys stay on the server.
- **Without a key** a deterministic interpreter is used. It composes parameters, entity filters, magnitudes, durations and a
  concept lexicon (disease, war, breakthrough, tech hub, billionaire …). It says so in every reply, and reports anything it
  cannot represent as *not executed* — it never pretends.

"What if …" questions run in an isolated branch next to a control run of the unchanged world; direct instructions change the
live world (with an automatic pre-intervention snapshot, so every intervention has an **Undo**).

## Architecture

| Module | File |
| --- | --- |
| World state model, seeded RNG | `server/sim/types.ts`, `rng.ts`, `world.ts` |
| Population + city generator | `server/sim/generate.ts` |
| Individual agent engine (monthly decision cycle) | `server/sim/agents.ts` |
| Organisations, labour market, business formation | `server/sim/orgs.ts`, `economy.ts` |
| Economy, prices, wages, credit, stock market | `server/sim/economy.ts` |
| Government, central bank, elections | `server/sim/government.ts` |
| Healthcare + agent-level epidemic | `server/sim/health.ts` |
| Education, technology, housing/infrastructure, society/demography | `education.ts`, `technology.ts`, `housing.ts`, `social.ts` |
| Scheduler (daily / weekly / monthly systems) | `server/sim/tick.ts` |
| Parameter + operation registries, plan validator | `server/god/params.ts`, `ops.ts` |
| Interpreters (LLM adapter + deterministic) | `server/god/interpret.ts` |
| GOD MODE pipeline, queries, reporting | `server/god/service.ts` |
| Persistence (SQLite), runtime, timelines, API | `server/db.ts`, `runtime.ts`, `index.ts` |
| 3D renderer and interface | `src/City.tsx`, `App.tsx`, `Panels.tsx` |

To extend GOD MODE add an entry to `PARAMS` (a new world parameter), `EVENTS` or `OPS` — both interpreters and the validator pick
it up automatically.

## Model notes and limits

- One tick is one day; months are 30 days and years 360. A year simulates in well under a second.
- Citizens decide with utility functions, not LLM calls. The LLM is used only to interpret instructions and (optionally) to
  phrase explanations, which are labelled as AI-generated and built only from engine numbers.
- The economy is a stylised model: external demand reacts to local labour slack, the "rest of the world" absorbs imports and
  exports, and a national grant balances the founding budget. It produces plausible cycles, not forecasts.
