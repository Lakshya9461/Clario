# Clario beta: API contract and build rules

Stack: React (Vite) client + Express/Mongoose/zod server, one LLM behind `server/llm.js`
(Strata, OpenAI-compatible). Text only, college students. Auth is required: a bcrypt password hash,
a JWT in an httpOnly cookie, and the roles `student`/`admin`. Every session and its evidence belongs
to one account; a session id is never enough to read it.

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
3. Evidence is append-only. There is no update route; the only deletions are the owner deleting
   the session the evidence belongs to (`DELETE /sessions/:id`, the owner's right to withdraw their
   data) and the operator-only `server/scripts/teardown.js`.
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

### GET /topics
What a student can start right now, so the client can offer choices instead of a 404.

Res `200`: `{ "topics": [{ "topic": string, "source": "curated"|"generated", "reviewed": boolean }] }`
- Packs that ship with the repository come first, curated before generated; packs that exist only
  in the store follow. One entry per topic, compared case-insensitively.
- `reviewed` answers a different question from `source`: a generated pack committed to the
  repository was read and key-checked before it got there, while one still only in the store may
  be exactly as the model wrote it. `source` still decides A4's `certainty`, so a reviewed
  generated pack never says `demonstrated`.
- No model call and no evidence: this is a list, not a generation.

Errors: none of its own; it is mounted behind the same per-address rate limit as everything else.

### POST /session
Start a session on an existing pack.

Req: `{ "topic": string, "goal"?: string, "sourceText"?: string }`
- `goal` is free text, truncated to 40 characters. Empty is allowed.
- Any non-empty `sourceText` is refused: this build only serves prepared topics.

Res `201`: `{ sessionId, topic, packId, packStatus: "curated"|"generated", goal, firstQuestion: Question|null, done: boolean }`

Errors: `400 invalid_topic` (empty, non-string, whitespace-only, or over 120 characters),
`400 source_text_not_supported`, `404 topic_not_available`.

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
Res: `{ correct: boolean|null, selfReport: boolean, feedback: string, nextQuestion: Question|null, checkComplete: boolean, degraded: boolean }`
- `correct` is `null` exactly when `selfReport` is `true`: the student rated themselves, so
  there is no right answer to be right about. The client must not read `null` as "wrong".
- The check is one question per difficulty tier, 1 → 3, three in total.
- A written answer counts as `correct` only when every concept event the grader returned is
  `correct`; a partial answer is evidence, not a pass.
- `answer` and `why` are each capped at 4000 characters.

Errors: `400 invalid_answer`, `400 answer_too_long`, `400 question_not_found`,
`404 session_not_found`, `404 topic_not_available` (the session's pack is gone),
`409 question_already_answered`, `503 busy`.

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

### GET /sessions
The caller's own sessions, newest first.

Req query: `page?` (default 1), `limit?` (default 20, at most 50 — a larger value is a 400),
`topic?` (exact match, case-insensitive), `q?` (substring match on the title, case-insensitive).
An empty value means the filter is absent, not "match nothing".

Res `200`: the list envelope `{ items, page, limit, total, totalPages }`, items of
`SessionSummary = { id, title, topic, packId, packStatus, goal, answeredCount, createdAt }`.
`title` falls back to the topic for sessions written before titles existed. `userId` is never sent.

Errors: `401 unauthorized`, `400 invalid_request` (bad `page`/`limit`/`topic`/`q`).

### GET /sessions/:id
One session, owned by the caller (admins may read any).

Res `200`: `{ "session": SessionSummary }`.

Errors: `401 unauthorized`, `404 session_not_found` (unknown, malformed, or not yours).

### PATCH /sessions/:id
Rename a session. `title` must be 1–120 characters and is stored trimmed.

Req: `{ "title": string }`
Res `200`: `{ "session": SessionSummary }`.

Errors: `401 unauthorized`, `400 invalid_request` (empty, over 120, or not an object),
`404 session_not_found`.

### DELETE /sessions/:id
Delete a session and its evidence events. The owner's right to withdraw their data.

Res `204` with no body.

Errors: `401 unauthorized`, `404 session_not_found`.

### GET /admin/packs
Every stored pack — packs shipped in `server/packs/` are code and are not listed here.

Req query: `page?`, `limit?`, `q?` (substring match on the topic), `status?` (`curated` | `generated`).

Res `200`: the list envelope, items of `PackSummary = { id, packId, topic, topicKey, status, version,
conceptCount, questionCount, reviewedBy, reviewedAt, createdAt }`. Answer keys are not in the list.

Errors: `401 unauthorized`, `403 forbidden` (a student), `400 invalid_request`.

### GET /admin/packs/:id
One stored pack, whole JSON included (answer keys and all) — approving a pack is checking its keys,
so the reviewer needs them.

Res `200`: `{ "pack": PackSummary & { pack: <full pack JSON> } }`.

Errors: `401 unauthorized`, `403 forbidden`, `404 pack_not_found`.

### POST /admin/packs
Import a pack JSON. The body must pass `validatePack` as a **generated** draft — `status` in the body
is ignored, so a body cannot approve itself.

Res `201`: `{ "pack": PackSummary }`.

Errors: `401 unauthorized`, `403 forbidden`, `400 invalid_request`,
`409 pack_exists` (a pack for that topic, or another pack using that `packId`),
`422 pack_invalid` (`{ error, message, errors: string[] }` — the validator's reasons; nothing is stored).

### PUT /admin/packs/:id
Replace a stored pack. Re-validated as a draft, exactly like the import: `packId` cannot change,
`topicKey` is recomputed, and **an earlier approval is cleared** (the reviewed bytes are gone).

Res `200`: `{ "pack": PackSummary & { pack: <full pack JSON> } }`.

Errors: `401 unauthorized`, `403 forbidden`, `400 invalid_request`, `404 pack_not_found`,
`409 pack_exists`, `422 pack_invalid`.

### POST /admin/packs/:id/approve
The only route that makes a pack `curated`. `validatePack` runs again on the pack first, then
`pack.status` becomes `curated`, and `reviewedBy`/`reviewedAt` are set to the admin's email and now.

Res `200`: `{ "pack": PackSummary & { pack: <full pack JSON> } }`.

Errors: `401 unauthorized`, `403 forbidden`, `404 pack_not_found`, `422 pack_invalid`
(nothing is blessed).

### DELETE /admin/packs/:id
Delete a stored pack. Nothing else is deleted — sessions that already ran on it keep their history.

Res `204` with no body.

Errors: `401 unauthorized`, `403 forbidden`, `404 pack_not_found`.

### GET /admin/users
Every account, newest first.

Req query: `page?`, `limit?`, `q?` (substring match on name or email), `role?` (`student` | `admin`).

Res `200`: the list envelope, items of `{ id, name, email, role, createdAt }`. Keys hashed at rest
are never returned.

Errors: `401 unauthorized`, `403 forbidden`, `400 invalid_request`.

### PATCH /admin/users/:id/role
Change one account's role. The caller cannot change their own role
(`400 cannot_change_own_role`); any other account may be switched between `student` and `admin`.

Req: `{ "role": "student" | "admin" }`
Res `200`: `{ "user": { id, name, email, role, createdAt } }`.

Errors: `401 unauthorized`, `403 forbidden`, `400 invalid_request` (any other `role`),
`400 cannot_change_own_role`, `404 user_not_found`.

### GET /admin/analytics/overview
The numbers behind the admin dashboard. Nothing is stored: every figure is derived per request from
what is already in Mongo. Admin-only, like every `/admin/*` route.

Req query: `topic?` (substring-free, spells a topic as its pack stores it; 1–120 characters). When
omitted, the outcome table uses the topic with the most sessions.

Res `200`:
```
{ "sessionsPerDay": [{ "date": "YYYY-MM-DD", "count": number }],   // exactly 30 UTC days, zero-filled, oldest first
  "evidenceByQuality": [{ "quality": "code_keyed"|"llm_keyed"|"llm_graded"|"self_reported", "count": number }],  // every label present, zero-filled
  "outcomesByConcept": {
    "topic": string|null,
    "topicSource": "given"|"most_sessions"|null,
    "packAvailable": boolean,                                       // false when the pack is gone; concepts then come from the rows alone
    "concepts": [{ "conceptId", "name", "status": "mastered"|"emerging"|"struggling"|"unassessed",
                   "events": number, "outcomes": { "correct", "incorrect", "partial", "unsure" } }]
  },
  "topicsBySessions": [{ "topic": string, "sessions": number }],    // top 10, ranked by session count
  "degradedRate": { "recorded": false, "rate": null } }
```
- `mastered`: at least 2 graded events (correct + incorrect) and at least 60% correct.
  `struggling`: incorrect ≥ correct and at least one incorrect. `unassessed`: no events at all.
  Everything else with events is `emerging`. Partial/unsure never make a concept `mastered`.
- Degraded LLM replies are not recorded anywhere, so there is no rate: `recorded: false, rate: null`,
  never a fabricated 0.

Errors: `401 unauthorized`, `403 forbidden` (a student), `400 invalid_request`,
`404 topic_not_available` (an explicit `topic` with no pack; the derived default degrades to `packAvailable: false` instead).

### GET /health
Res `200`: `{ "status": "ok" }`. Used by the container healthcheck.

## Shared types
```
Question = { id, kind: "mcq"|"predict_output"|"free_text", prompt, conceptIds: string[],
             difficulty: 1|2|3, transfer: boolean, requiresWhy: boolean,
             options?: string[], code?: string }
TraceData = { code: string, steps: [{ stack: string[], output: string[], note: string }] }
ListEnvelope = { items: T[], page: number, limit: number, total: number, totalPages: number }
```
`publicQuestion()` in `engine/session.js` builds the client copy: it never includes `answerKey`,
`rubric` or fallback feedback, so the answer never leaves the server. The pack's `selfReport` mark
is one of those server-side facts: a self-report question looks like an ordinary one on screen, and
the answer route reports `selfReport: true` with `correct: null` after it is answered.

`options` are already in the order the student sees, and the key is the option *text* in that
order, so grading can never disagree with the screen.

## Error codes
| Status | `error` | When |
| --- | --- | --- |
| 400 | `invalid_topic` | `topic` is missing, not text, empty, or over 120 characters |
| 400 | `invalid_answer` | no answer and no `skip: true` |
| 400 | `answer_too_long` | `answer` or `why` over 4000 characters |
| 400 | `question_not_found` | `questionId` is not in that pack section |
| 400 | `step_not_found` | `stepIndex` is not a step of this plan |
| 400 | `source_text_not_supported` | any non-empty `sourceText` |
| 400 | `invalid_request` | a malformed body, params, or query string (failed zod), or `role` other than `student`/`admin` |
| 400 | `cannot_change_own_role` | an admin tried to change their own role |
| 401 | `unauthorized` | no token, or an expired/invalid cookie |
| 403 | `forbidden` | a student used an admin route |
| 404 | `topic_not_available` | no bundled or stored pack for that topic, or the session's pack is gone |
| 404 | `session_not_found` | unknown or malformed `sessionId` |
| 404 | `pack_not_found` | no stored pack with that id (a bundled file is not addressable via this route) |
| 404 | `user_not_found` | no user with that id |
| 404 | `not_found` | no route for that method and path |
| 409 | `question_already_answered` | the question was already claimed; nothing is graded twice |
| 409 | `pack_exists` | the topic (or `packId`) is already taken by a stored pack |
| 422 | `pack_invalid` | a pack failed `validatePack` on import, edit, or approve; `errors: string[]` says why |
| 429 | `rate_limited` | more requests than the allowance in the window from one address (`RATE_LIMIT_MAX`, default 60 per minute); `Retry-After` says when to retry |
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
Password reset, email verification, admin bootstrap outside `scripts/seed-admin.js`,
bundled-pack editing (a curated JSON file in the repository is read-only from the API by design),
cross-session history beyond the list above, spaced review, uploads, open-web search, generated diagrams,
video, learner-profile editing, retention policy, a second curated pack.
