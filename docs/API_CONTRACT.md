# Clario beta: API contract and build rules

Stack: React (Vite) + Express + MongoDB, one LLM behind `server/llm.js` (Strata, OpenAI-compatible).
Scope: ONE topic (python-recursion), text only, college students, no auth (session id in localStorage).

## Rules for the coding agent
1. Build one endpoint at a time. Test with curl before touching the UI. Commit after each working step.
2. Do NOT add auth, uploads, web search, video, payments, extra libraries, or features not listed here.
3. The LLM never writes estimates. It returns JSON that the server validates with zod; on failure retry once, then use the fallback from `questions.json`.
4. Never run student-supplied or LLM-written code on the host. Grade by exact match (code-graded) or by the LLM (only for the "why" answers).
5. All LLM calls go through `llm.js`. The API key / base URL live in `.env`, never in the frontend.
6. Evidence is append-only. Estimates are computed on request by `computeEstimate()` in `models.js`.
7. Run at most 1-2 LLM requests at a time (queue the rest). Return a clear "busy" state to the UI.
8. Static files in the repo: `concepts.json`, `sources.json` (chunks with title, url, license, text), `questions.json` (diagnostic and check questions, answer keys, fallbacks, trace data).

## Endpoints

### POST /session
Req: `{ "goal": "course|assignment|exam|curiosity" }`
Res: `{ "sessionId": "...", "firstQuestion": Question }`

### POST /diagnose
Req: `{ "sessionId", "questionId", "answer": "string", "skip": false }`
Server: grade (code-graded when the question has an exact key), ask the LLM to propose evidence events, validate, append.
Res: `{ "nextQuestion": Question | null, "done": boolean, "evidenceCount": number, "lowEvidence": boolean }`
Stop after 3-5 questions or when the student passes `skip: true` (then set `lowEvidence = true`).

### GET /plan/:sessionId
Res: `{ "objective": string, "findings": [{conceptId, status, confidence, why}], "steps": [{conceptId, title, reason}] }`
Steps come from the graph (prerequisites of unmet concepts first); `reason` text may be LLM-written, order is not.

### POST /lesson
Req: `{ "sessionId", "stepIndex" }`
Res: `{ "markdown": string, "citations": [{sourceId, title, url}], "trace": TraceData | null, "workedExample": string }`
Lesson text must only use supplied source chunks for factual claims; every cited sourceId must exist in `sources.json`. `trace` is hard-coded data from `questions.json` for the call-stack step-through.

### POST /check
Req: `{ "sessionId", "questionId", "answer", "why": "string|null" }`
Res: `{ "correct": boolean, "feedback": string, "nextQuestion": Question | null, "checkComplete": boolean }`
Check = 3 questions at rising difficulty, one transfer, one requiring a short "why". Fresh question each attempt.

### GET /model/:sessionId
Res: `{ "concepts": [{ id, name, status, confidence, eventCount, notes: [string] }], "lowEvidence": boolean }`
Read-only in the beta. Show "unknown" as unassessed, never as weakness.

## Shared types
```
Question = { id, prompt, kind: "predict_output"|"mcq"|"free_text", options?: string[],
             conceptIds: string[], difficulty: 1|2|3, transfer: boolean, requiresWhy: boolean }
TraceData = { code: string, steps: [{ stack: string[], output: string[], note: string }] }
```

## Error handling
All endpoints return `{ "error": "code", "message": "..." }` with a proper status code. If the LLM is slow or invalid, return the fallback content with `"degraded": true` so the UI can show it.

## Out of scope for the beta (do not build)
Accounts, cross-session history, spaced review, uploads, open-web search, LLM-generated diagrams, video, comparison study tooling, learner-profile editing.
