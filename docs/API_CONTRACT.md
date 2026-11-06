# Clario beta: API contract and build rules

Stack: React (Vite) client + Express/Mongoose/ zod server, one LLM behind `server/llm.js`
(Strata, OpenAI-compatible). Text only, college students, no auth: the session id is a Mongo
ObjectId kept in `localStorage` on the client.

Scope: **any** topic, but only topics whose pack already exists. A session runs on a curated
JSON pack from `server/packs/` or on a pack an offline generation run stored in Mongo. **No
endpoint generates a pack** — generation takes minutes (`server/packs/generate.js`, run from
`scripts/generate-preview.js`), so an unprepared topic is a 404, not a slow request.

This document describes Phase 3 as implemented. Where it disagrees with an amendment in the
README (A1–A5), the amendment wins.

## Rules the code enforces

1. The LLM never writes an estimate, a status or a confidence. It may propose evidence events;
   `appendEvents()` in `routes.js` drops any event whose `conceptId` is not in the pack.
2. Estimates are derived per request by `computeEstimate()` in `server/models/models.js` and are
   never stored.
3. Evidence is append-only. There is no update or delete route; the only deletion path is the
   operator-only `server/scripts/teardown.js`.
4. Student text goes into a prompt only through `server/data-tags.js` (`asData`/`attribute`), which
   neutralises the closing tag. Student *answers* are additionally capped at 4000 characters at
   the route boundary.
5. Never execute student- or LLM-written code. A lesson's `trace` is generated data rendered as
   text, never run.
6. All LLM calls go through `server/llm.js`, which streams, retries once, then falls back with
   `degraded: true`. A busy queue is `503 busy`, never `degraded`.
7. Every error is `{ "error": "<code>", "message": "<sentence>" }`. Internal failures say
   "Something went wrong.", never a stack trace.

## Endpoints

All requests and responses are JSON. The client origin must be listed in `CLIENT_ORIGIN`
(exact match, no wildcard) or the browser request is refused by CORS.

### POST /session
Start a session on an existing pack.

Req: `{ "topic": string, "goal"?: string, "sourceText"?: string }`
- `goal` is free text, truncated to 40 characters. Empty is allowed.
- Any non-empty `sourceText` is refused: this build only serves prepared topics.

Res `201`: `{ sessionId, topic, packId, packStatus: "curated"|"generated", goal, firstQuestion: Question|null, done: boolean }`

Errors: `400 source_text_not_supported`, `404 topic_not_available`.

### POST /diagnose
Answer or skip one diagnostic question.

Req: `{ "sessionId", "questionId", "answer"?: string, "skip"?: boolean }`
- `answer` is required unless `skip` is `true`; it is trimmed and capped at 4000 characters.
- A skip records no evidence and sets `skippedDiagnosis`, which the plan and model report as
  `lowEvidence`. A skipped question is never asked again.

Res `200`: `{ nextQuestion: Question|null, done: boolean, evidenceCount: number, lowEvidence: boolean, answeredCount: number, minDiagnostic: number }`
- The diagnostic stops after 3–5 answered questions, and only once every difficulty tier the
  pack has (1, 2, 3) is covered. `done` is what the client should follow, not the count.

Errors: `400 invalid_answer`, `400 answer_too_long`, `400 question_not_found`,
`404 session_not_found`, `404 topic_not_available` (the session's pack is gone),
`409 question_already_answered`, `503 busy`.

### GET /plan/:sessionId
Read the plan. Recomputed from evidence on every call; nothing is stored.

Res `200`:
```
{ "objective": string,
  "findings": [{ "conceptId", "title", "status", "confidence", "eventCount",
                 "certainty": "demonstrated"|"likely demonstrated"|null, "why": string }],
  "steps": [{ "conceptId", "title", "description", "prerequisites": string[], "reason": string }],
  "packStatus": "curated"|"generated",
  "degraded": boolean }
```
- `findings` has one entry per pack concept, in the pack's order, including `unknown` ones.
- `steps` is the ordered work list (prerequisites first, at most 5), excluding concepts whose
  status is `demonstrated`. Order and membership are decided in code; the LLM only writes
  `objective`, `why` and `reason`.
- `certainty` applies A4: only a curated pack graded in code says `demonstrated`; everything else
  that meets the rule says `likely demonstrated`, and a non-demonstrated concept says `null`.

Errors: `404 session_not_found`, `404 topic_not_available`, `503 busy`.

### POST /lesson
Read one lesson for one plan step.

Req: `{ "sessionId", "stepIndex": number }` — `stepIndex` is a position in the plan's `steps`.

Res `200`:
```
{ "conceptId", "stepIndex", "markdown", "citations": [{ "sourceId", "title", "url" }],
  "trace": TraceData|null, "workedExample": string, "degraded": boolean }
```
- Factual claims must come from the pack's sources or be prefixed "General explanation:".
- `citations` only name sources that exist in the pack.
- `trace` is generated data for a step-through visual, never executed.

Errors: `400 step_not_found`, `404 session_not_found`, `404 topic_not_available`, `503 busy`.

### POST /check
Two modes on one route.

Fetch mode — no `questionId`:
Req: `{ "sessionId" }`
Res: `{ correct: null, feedback: null, nextQuestion: Question|null, checkComplete: boolean, degraded: false }`
This is how the client gets the first check question after the diagnostic; nothing else hands
out a check question.

Answer mode — with `questionId`:
Req: `{ "sessionId", "questionId", "answer": string, "why"?: string }`
Res: `{ correct: boolean, feedback: string, nextQuestion: Question|null, checkComplete: boolean, degraded: boolean }`
- The check is one question per difficulty tier, 1 → 3, three in total.
- A written answer counts as `correct` only when every concept event the grader returned is
  `correct`; a partial answer is evidence, not a pass.
- `answer` and `why` are each capped at 4000 characters.

Errors: `400 invalid_answer`, `400 answer_too_long`, `400 question_not_found`,
`404 session_not_found`, `409 question_already_answered`, `503 busy`.

### GET /model/:sessionId
Read the derived learner model. Read-only in the beta.

Res `200`:
```
{ "concepts": [{ "id", "name", "status", "confidence", "eventCount", "notes": string[] }],
  "lowEvidence": boolean }
```
`status`: `unknown` | `self_reported` | `developing` | `demonstrated`.
`confidence`: `none` | `low` | `moderate` | `high`.
`unknown` means unassessed, never a weakness; it carries no notes.

Errors: `404 session_not_found`, `404 topic_not_available`.

### GET /health
Res `200`: `{ "status": "ok" }`. Used by the container healthcheck.

## Shared types
```
Question = { id, kind: "mcq"|"predict_output"|"free_text", prompt, conceptIds: string[],
             difficulty: 1|2|3, transfer: boolean, requiresWhy: boolean,
             options?: string[], code?: string }
TraceData = { code: string, steps: [{ stack: string[], output: string[], note: string }] }
```
`publicQuestion()` in `engine/session.js` builds the client copy: it never includes `answerKey`,
`rubric` or fallback feedback, so the answer never leaves the server.

`options` are already in the order the student sees, and the key is the option *text* in that
order, so grading can never disagree with the screen.

## Error codes
| Status | `error` | When |
| --- | --- | --- |
| 400 | `invalid_answer` | no answer and no `skip: true` |
| 400 | `answer_too_long` | `answer` or `why` over 4000 characters |
| 400 | `question_not_found` | `questionId` is not in that pack section |
| 400 | `step_not_found` | `stepIndex` is not a step of this plan |
| 400 | `source_text_not_supported` | any non-empty `sourceText` |
| 404 | `topic_not_available` | no curated or stored pack for that topic, or the session's pack is gone |
| 404 | `session_not_found` | unknown or malformed `sessionId` |
| 404 | `not_found` | no route for that method and path |
| 409 | `question_already_answered` | the question was already claimed; nothing is graded twice |
| 429 | `rate_limited` | more than 60 requests in a minute from one address; `Retry-After` says when to retry |
| 503 | `busy` | LLM queue full (2 in flight, 3 waiting). Retry; this is not `degraded` |
| 500 | `server_error` | anything else; the message is always "Something went wrong." |

`topic_not_supported` (422) and `generation_unavailable` (503) belong to the offline generation
script, not to an HTTP route: a closed or unusable topic is never generated, and a model that
cannot be reached during generation fails the script. Once a route is running, an unreachable
model is not an error code at all — it is `degraded: true` on a 200.

## Degraded responses
Every route that asks the model for wording ("`objective`", "`why`", "`feedback`", a lesson)
returns usable fallback text written by the server plus `"degraded": true`. The client says so
instead of pretending the model answered.

## Out of scope for the beta
Accounts, cross-session history, spaced review, uploads, open-web search, generated diagrams,
video, learner-profile editing or deletion, retention policy, a second curated pack.
