# Clario (beta)

Adaptive-learning web app for college students. Works for **any** topic the student
enters: the engine holds no topic-specific code, text, questions or graphs. All topic
content lives in **packs**.

- `server/` — Node + Express + MongoDB (Mongoose). `server/models/` has the data model,
  `server/packs/` has curated topic packs and their loader/validator.
- `client/` — React (Vite) SPA.
- `docs/API_CONTRACT.md` — API contract. `server/models/models.js` — data model.
  Amendments A1–A5 (topic packs, question shape, `POST /session`, evidence quality,
  no web search) take precedence over the contract where they conflict.

## Requirements

- Node 22+ (developed on Node 26), npm
- MongoDB (only needed from the phase that stores sessions/evidence; Phase 0 does not connect)
- Strata, a local OpenAI-compatible LLM server (only needed from the phase that calls the LLM)

## Setup

```bash
cd server && npm install && cp .env.example .env   # then fill in .env
cd ../client && npm install
```

`.env` lives only in `server/` and is git-ignored. Keys: `PORT`, `MONGO_URL`,
`LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`, `LLM_TIMEOUT_MS`, `CLIENT_ORIGIN`,
`RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS`.
`LLM_TIMEOUT_MS` is optional (default 90000) and caps one completion, streaming included.
`RATE_LIMIT_MAX` and `RATE_LIMIT_WINDOW_MS` are optional (default 60 requests per 60000 ms):
raise them when several people share one address, such as a campus or lab NAT.

The LLM client streams every completion. Generation asks for ~2k tokens of JSON, which a
slow model can take minutes over, and a proxy in front of the LLM (Cloudflare and friends)
aborts a request that has sent nothing for about 100 seconds while it keeps a stream alive.
A server that ignores `stream` and answers with one JSON body still works.

## Run

Two terminals:

```bash
cd server && npm run dev     # http://127.0.0.1:3000
cd client && npm run dev     # http://localhost:5173
```

Check the server:

```bash
curl -s http://127.0.0.1:3000/health
# {"status":"ok"}
```

## Test

```bash
cd server && npm test        # node --test: packs, validator, generation, llm, estimates
cd server && npm run smoke   # one text + one JSON request against the local Strata server
```

`npm run smoke` prints the base URL, whether the model and key are configured, and the
timing and validity of each reply. It fails loudly if Strata is down or replying badly.

## Packs

A pack is one JSON file (A1):

```jsonc
{
  "packId": "sample-topic-a",
  "topic": "…",                  // matched case-insensitively against what the student types
  "status": "curated",           // curated packs are committed here; generated drafts live in Mongo
  "version": "0.1-beta",
  "concepts": [{ "id", "name", "description", "prerequisites": ["…"] }],
  "diagnostic": [Question],
  "check": [Question],
  "traces": { "id": TraceData },  // hard-coded step-through data, never executed
  "sources": [{ "id", "title", "url", "license", "text" }]
}
```

A question (A2) is
`{ id, kind: "mcq"|"predict_output"|"free_text", prompt, code?, options?, conceptIds[],
difficulty: 1|2|3, transfer, requiresWhy, answerKey: { type, value } | null, rubric?,
fallbackFeedback, optionHints? }`. Generated packs may only use `mcq` and `free_text`.

`server/packs/loader.js` validates every pack before use: required fields, unique concept /
question / source ids, every prerequisite exists, the prerequisite graph is acyclic, every
question's `conceptIds` exist, every `mcq` answer key is one of its own options, every
`traceId` exists, source URLs parse. Add a pack by dropping `<name>.json` into
`server/packs/` and running `npm test`.

Questions with `answerKey: null` and `kind: "mcq"` are self-report items: they produce
`self_report` evidence and are never counted as demonstrated.

### Generated packs

`server/packs/generate.js` turns a topic the app has no curated pack for into a draft:
concepts (8–14, graph validated), then 8 diagnostic + 8 check questions (at least 2/3/3
across difficulty 1/2/3 per list, 1–2 free-text each), then a self-consistency pass in
which every mcq is re-answered by the model without the key and dropped if the answers
disagree. Options are shuffled in code before that check, so the order the model happened
to write cannot pass it. What survives is kept: a pack needs 3 questions per list (at
least 2 of them mcq, at most 2 free-text) with one per difficulty, and the draft is
retried once as a whole before `topic_not_supported` (HTTP 422) is raised. An unreachable
model is not an unsupported topic: it raises `generation_unavailable` (HTTP 503) and no
pack is invented. Drafts are stored in the `packs` collection and cached by normalized
topic, so the same topic is never drafted twice.

Prompts live in the `prompts` export of that file. All of them wrap user-supplied text in
tags, defuse closing tags inside it, and tell the model it is data, never instructions.
With source text the model is told to use only that text as its factual basis; with none,
to use general knowledge and never invent a citation or URL.

`npm run generate:preview` runs generation for five topics against Strata and Mongo
(three real, one nonsense, one prompt-injection attempt — the gate must refuse the last two)
and prints, per topic: the time taken, the pack id and validator result, how many questions
the self-check drafted and dropped, the concept graph, and three questions with their keys.
It exits non-zero if a topic does not land where expected or if a pack echoes any of our own
prompt text.

Two scripts exist for demo preparation and inspection:

```bash
cd server && npm run learners [apiUrl] [topic]   # three scripted learners, three plans
cd server && npm run teardown -- --dry-run       # then --yes: wipe sessions, evidence, packs
```

`npm run learners` drives a live API over HTTP as a beginner, a partial and a strong
learner and writes the raw responses to `~/.cache/tmp/opencode/clario-learners/`.
`npm run teardown` deletes every session, evidence event and generated pack; it prints a
redacted connection string, refuses to run without `MONGO_URL`, and needs `--yes` to delete.

## Status

Phases 0–3. The API serves six routes plus `GET /health` (`docs/API_CONTRACT.md`): start a
session on a prepared topic, diagnose, plan, lesson, check, summary. No route generates a
pack — generation is the offline script above — so an unprepared topic is a 404. What the
beta does not do is in `docs/LIMITATIONS.md`; how to deploy it is in `deploy/README.md`.
