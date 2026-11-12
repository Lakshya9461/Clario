# Clario

Two independent packages, no root manifest and no shared code: `server/` (CommonJS,
Express + Mongoose + zod + dotenv) and `client/` (ESM, React 19 + Vite). `npm install`
must be run in each.

## Layout

`server/` keeps one job per directory:

| Path | Holds |
| --- | --- |
| `config/` | `env.js` — every `process.env` read, parsed once into one object, plus the boot gate that refuses to start without `MONGO_URL` and `JWT_SECRET`. `db.js` — the Mongo connection and `redactUrl()`. |
| `middleware/` | `error.js` (the JSON 404, the central error handler, `toHttpError()`), `validate.js` (`validate(schema)` with zod, for a body or a params source), `rate-limit.js`. |
| `controllers/` | one module per resource — `topics`, `session` (create + diagnose), `plan`, `lesson`, `check`, `model` — plus the shared answer path (`answers.js`), evidence writing (`evidence.js`) and the derived learner view (`learner-view.js`). |
| `routes/` | `index.js` — the route table and the composition root (`defaultDeps`). Nothing else. |
| `models/` | `models.js` — the Mongoose schemas and `computeEstimate()`. |
| `engine/`, `packs/`, `llm.js`, `data-tags.js`, `scripts/` | the deterministic engine, topic packs, the LLM client, prompt tagging, offline scripts. |

A handler never imports Mongoose or `llm.js`: it receives `deps`. A new route is a controller
function plus one line in `routes/index.js`.

## Commands

```bash
cd server && npm test          # node --test, every *.test.js (200+ tests)
cd server && node --test packs/generate.test.js            # one file
cd server && node --test --test-name-pattern "cached pack" # one test
cd client && npm run lint      # oxlint; npm run build. The client has no test suite.
cd server && npm run dev       # http://127.0.0.1:3000   (GET /health)
cd client && npm run dev       # http://localhost:5173
```

Server tests need no network and no Mongo: the model is a stub and the store is a Map.
`npm run smoke` and `npm run generate:preview` do need Strata (and Mongo);
`PREVIEW_FRESH=1` forces a rerun past the cached packs. `npm run learners` needs a live
API and Mongo, and `npm run teardown -- --yes` deletes every session, evidence event and
generated pack.

## Gotchas

- Open the client at `http://localhost:5173`, **not** `http://127.0.0.1:5173`. The CORS
  allowlist is `CLIENT_ORIGIN` (default `http://localhost:5173`), so the other origin is
  dropped and reads as "Cannot reach the Clario server".
- Nothing outside `config/env.js` reads `process.env`. A new setting is added there (with its
  default and, if the app cannot invent it, to the boot gate) and to `server/.env.example`.
  `index.js` refuses to start without `MONGO_URL` and a `JWT_SECRET` of at least 32 characters,
  and its message names variables only — never a value.
- `.env` exists only in `server/` and is git-ignored. A Mongo URL must never reach a log
  unredacted — use `redactUrl()` in `config/db.js`.
- Every LLM call goes through `server/llm.js` and **streams**. A non-streaming call is
  killed by the proxy in front of the model after ~100 s of silence, so `stream: true` is
  not an optimization, it is the requirement. `LLM_TIMEOUT_MS` defaults to 90000.
- `llm.js` runs 2 requests in flight and queues 3; past that it throws `LlmBusyError`,
  which the routes answer as 503 `{ error: "busy" }`. A busy queue is not `degraded`.
- `server/rate-limit.js` allows 60 requests a minute per address and answers 429
  `rate_limited` with a `Retry-After`; `RATE_LIMIT_MAX`/`RATE_LIMIT_WINDOW_MS` override it for a
  room where several people share one address. `/health` is mounted before it, so a monitor cannot
  be limited. It reads `req.ip`, which is the client only because `app.js` sets
  `trust proxy 1` and the deployment publishes nothing but the proxy.
- Token caps and reasoning modes in the generation prompts are **measured against the real
  model**, not guessed (`server/scripts/bench-selfcheck.js`, `bench-topic-check.js`).
  Changing a cap without rerunning the benchmark can silently truncate replies.

## Invariants

- No topic words anywhere outside `server/packs/`. The engine knows the pack *shape* only.
- The LLM never writes estimates or mastery. It proposes evidence; the server validates it
  against the pack's concepts. Evidence is append-only; estimates are recomputed per request
  by `computeEstimate()` in `server/models/models.js` and never stored.
- Every LLM reply is zod-validated, retried once, then falls back to generic text with
  `degraded: true`. An unreachable model is `generation_unavailable` (503), never
  `topic_not_supported` (422).
- Never execute student- or LLM-written code. `trace` is hard-coded data.
- Student and source text is wrapped in tags and declared data, never instructions
  (`server/data-tags.js`). A wrong answer is evidence about one question, phrased with
  "may"/"could", never a claim about what the student does not understand.
- No route generates a pack — generation is an offline script, so `POST /session` serves
  curated packs and already-generated ones and 404s `topic_not_available` otherwise.
- **Student-owned data is readable only by its owner or an admin.** A session, its evidence and
  its derived learner model belong to one student (`Session.owner`); every read path filters on
  the caller, and an admin may read any. Never trust a `sessionId` on its own.
- **Approved dependencies**: `bcryptjs`, `jsonwebtoken`, `cookie-parser`, `helmet` (server) and
  `react-router-dom` (client). Anything else needs the user's approval first — no exceptions for
  "it is only a dev tool".
- No features outside the documented phases (no uploads, web search, video). Auth is required, not
  optional: bcrypt password hashes, a JWT in an httpOnly cookie, and the roles `student`/`admin`.

## Testing shape

`createRouter(overrides)` in `server/routes/index.js` takes its dependencies (`chatJson`, `findEvents`,
`insertEvents`, `curatedPacks`, `findStored`, `claim`, …) so tests drive real HTTP over the same handlers
with fakes. Do not hardwire Mongoose or `llm.js` inside a handler or a controller — that breaks the tests.

`server/engine/fixtures.js` is not a `*.test.js` file, so `node --test` does not run it on
its own; its content is deliberately subject-free, which is what proves the engine needs no
topic.

## Docs and commits

`docs/API_CONTRACT.md` is the contract; the README amendments (A1–A5) take precedence where
they conflict. Commit after each working step, message style `<area>: <what changed>`.
