# Demo runbook

## Pre-flight

```sh
cd server
npm test
```
Use two terminals:

```sh
# terminal 1
cd server
npm run dev

# terminal 2
cd client
npm run dev
```
Open `http://localhost:5173`, not `http://127.0.0.1:5173`. The CORS allowlist is
`CLIENT_ORIGIN`; using the other origin reads as "Cannot reach the Clario server".
```sh
curl -s localhost:3000/health
curl -s localhost:3000/topics
```
The `topics` list is the source of truth. Use one of those prepared topics.

## Demo script

1. On Start, choose a topic from `GET /topics` and a goal. The client calls
   `POST /session`; the server loads an existing pack and returns the first question.
2. Answer diagnostics. The UI asks 3-5 questions across available tiers. Each
   `POST /diagnose` claims, grades, and appends evidence.
3. Point at the plan from `GET /plan/:sessionId`. The server recomputes findings and
   prerequisite order; model wording cannot choose status or order.
4. Open a lesson from `POST /lesson`. The server selects the plan step, asks for
   wording, filters citations, and returns trace data for display.
5. Start the check. The client fetches with `POST /check` without `questionId`, then
   submits one answer for each of the three tiers. The server grades and appends evidence.
6. Point at `GET /model/:sessionId`. Status and confidence are derived from append-only
   evidence; no stored estimate is read.

### Measured timings

Measured range: a single app request takes **0.3-21.1 seconds**. The two fast ones are the
ones worth knowing for a demo: an unprepared topic answers **404 in about 0.1 s**, and
starting a session on a prepared pack answers **201 in about 0.2 s** (both measured, no
model call). Model calls are the slow part; the plan step is the slowest. Any timing not
stated here is **not measured**. Model replies are streamed, and `LLM_TIMEOUT_MS` defaults
to `90000`.

## Failure drills

### No prepared pack

Use a value that is not in the `/topics` response:
```sh
curl -s -i -X POST localhost:3000/session \
  -H 'content-type: application/json' \
  -d '{"topic":"unprepared demo entry","goal":"exam"}'
```
Expected: **404**
```json
{"error":"topic_not_available","message":"This topic is not available yet. Try one that has already been prepared."}
```
This is fast and makes no model call: the server does not invent topics.

### Model queue full

Create enough simultaneous model-backed requests to exceed two in flight and three waiting.
The overflowing request returns **503**:
```json
{"error":"busy","message":"The study assistant is busy. Try again in a moment."}
```
Retry the **same answer** after the queue clears. It returns **200**, not `409`, because
the server releases the question claim when grading fails.

### Model unreachable

Stop or make the configured model endpoint unavailable, then submit a check answer.
The answer route still returns **200** with the pack's fallback feedback:
```json
{"correct":false,"selfReport":false,"feedback":"<pack fallback>","nextQuestion":null,"checkComplete":false,"degraded":true}
```
`correct`, `nextQuestion`, and `checkComplete` depend on progress; the stable signal
is the fallback text and `degraded:true`. The flow continues.

### Double submit

Submit the same `questionId` twice:
```json
{"error":"question_already_answered","message":"That question has already been answered."}
```
The second response is **409** and no second evidence event is written.

### Rate limit

Send more requests than the allowance from one address. With the default 60 per minute:
```sh
for i in $(seq 1 61); do curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/topics; done
```
If `RATE_LIMIT_MAX` has been raised (the demo `server/.env` sets 600 for a shared campus
NAT), send a count above the configured allowance instead, e.g. `seq 1 601`.
The refused response is **429**, includes `Retry-After`, and has this JSON body where
`N` is the remaining number of seconds:
```json
{"error":"rate_limited","message":"Too many requests from this connection. Try again in N seconds."}
```
The default is 60 requests per minute per address. Set `RATE_LIMIT_MAX` higher
for a shared campus NAT.

### Self-report question

When the first question has `selfReport:true`, answer it normally. The response is
**200** and includes:
```json
{"correct":null,"selfReport":true,"feedback":"Recorded as your own rating. It is kept apart from what you demonstrate, so it never counts as a correct answer.","nextQuestion":null,"checkComplete":false,"degraded":false}
```
The next question and completion flag depend on progress. The event is recorded as
`evidenceType:"self_report"` and `gradedBy:"student"`; it is not graded.

## Concurrent-session drill

From the repository root, run:
```sh
node server/scripts/demo-drills.js [sessions=3] [base=http://127.0.0.1:3000]
```
The script reads `GET /topics`, starts all sessions concurrently on the first prepared
topic with goal `exam`, answers one diagnostic question per session, and prints one line
per session with status and elapsed milliseconds. It then prints counts for sessions
started (`201`), answers graded (`200`), `503`, failures, and successful retries. A `503`
is retried once with the same answer. Exit status is 0 when every session ends in `201` or
`200`, otherwise 1. It uses only global `fetch` and plain Node.

## If the demo breaks

| Symptom | Cause | Fix |
|---|---|---|
| Cannot reach the Clario server | The client was opened on the wrong origin. | Open `http://localhost:5173`. |
| 429 | The address used its request allowance. | Wait for `Retry-After`, or raise `RATE_LIMIT_MAX` for a shared address. |
| 503 busy | The model queue is full, not a grading bug. | Wait 2 seconds and resubmit the same answer. |
| 404 topic_not_available | The chosen topic is not prepared. | Choose a topic returned by `GET /topics`. |
| Blank plan | The diagnostic was short or skipped, so evidence is low. | Complete more diagnostic questions; `lowEvidence` is expected. |
