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
`LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`, `CLIENT_ORIGIN`.

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
cd server && npm test        # node --test: pack validator + sample pack
```

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

## Status

Phase 0 (repo + pack layout): `GET /health`, pack loader/validator and tests exist. No
sessions, LLM calls, evidence or UI features yet.
