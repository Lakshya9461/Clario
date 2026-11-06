# Clario

Two independent packages, no root manifest and no shared code: `server/` (CommonJS,
Express + Mongoose + zod + dotenv) and `client/` (ESM, React 19 + Vite). `npm install`
must be run in each.

## Commands

```bash
cd server && npm test          # node --test, every *.test.js (176 tests)
cd server && node --test packs/generate.test.js            # one file
cd server && node --test --test-name-pattern "cached pack" # one test
cd client && npm run lint      # oxlint; npm run build. The client has no test suite.
cd server && npm run dev       # http://127.0.0.1:3000   (GET /health)
cd client && npm run dev       # http://localhost:5173
```

Server tests need no network and no Mongo: the model is a stub and the store is a Map.
`npm run smoke` and `npm run generate:preview` do need Strata (and Mongo);
`PREVIEW_FRESH=1` forces a rerun past the cached packs.

## Gotchas

- Open the client at `http://localhost:5173`, **not** `http://127.0.0.1:5173`. The CORS
  allowlist is `CLIENT_ORIGIN` (default `http://localhost:5173`), so the other origin is
  dropped and reads as "Cannot reach the Clario server".
- `.env` exists only in `server/` and is git-ignored. A Mongo URL must never reach a log
  unredacted — use `redactUrl()` in `server/db.js`.
- Every LLM call goes through `server/llm.js` and **streams**. A non-streaming call is
  killed by the proxy in front of the model after ~100 s of silence, so `stream: true` is
  not an optimization, it is the requirement. `LLM_TIMEOUT_MS` defaults to 90000.
- `llm.js` runs 2 requests in flight and queues 3; past that it throws `LlmBusyError`,
  which the routes answer as 503 `{ error: "busy" }`. A busy queue is not `degraded`.
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
- No new dependencies without approval, and no features outside the documented phases
  (no auth, uploads, web search, video).

## Testing shape

`createRouter(overrides)` takes its dependencies (`chatJson`, `findEvents`, `insertEvents`,
`curatedPacks`, `findStored`, `claim`, …) so tests drive real HTTP over the same handlers
with fakes. Do not hardwire Mongoose or `llm.js` inside a handler — that breaks the tests.

`server/engine/fixtures.js` is not a `*.test.js` file, so `node --test` does not run it on
its own; its content is deliberately subject-free, which is what proves the engine needs no
topic.

## Docs and commits

`docs/API_CONTRACT.md` is the contract; the README amendments (A1–A5) take precedence where
they conflict. Commit after each working step, message style `<area>: <what changed>`.
