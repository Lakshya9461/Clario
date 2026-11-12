# Clario beta: what this build does not do

The beta is a demo of the engine, not a study tool you can rely on yet. Each limitation below is
verified against the code, with the file that causes it.

## Content

- **Generated packs are unreviewed unless an admin approved them.** A pack for a topic nobody
  curated is written by the model (`server/packs/generate.js`) and stored as-is once it passes schema
  validation, graph checks and the self-check. No human reads the questions or the answer keys.
  Curated packs live in `server/packs/*.json` and there is one of them (`sample-topic-a.json`).
- **"Approved" means a person read the pack, not that the pack is verified.** `POST
  /admin/packs/:id/approve` sets a stored pack to `status: "curated"`, records who did it and when
  (`reviewedBy`, `reviewedAt`), and re-runs the schema validator first — a pack that no longer
  validates cannot be approved. What that buys is a human having opened every question and checked
  every answer key; it does **not** mean the content was fact-checked, piloted with students, or
  assessed against a syllabus. It also does not regenerate anything: the approved pack is exactly the
  bytes the model wrote. Editing it afterwards clears the approval, because the reviewed bytes are
  gone.
- **An approval does not upgrade evidence that came before it.** A session records the pack status it
  started on (`Session.packStatus`), so answers graded while a pack was a draft stay `llm_keyed` and a
  concept can reach at most `likely demonstrated` for that session, even after the same pack is
  approved (`engine/session.js:provenanceFor`). Start a new session to practise on the approved keys.
- **A generated pack's answer keys are the model's own.** They are graded in code, exactly, but
  the key itself came from the model, so `evidenceQuality` is `llm_keyed`, never `code_keyed`
  (`engine/grading.js:keyedQuality`) — unless an admin approved the pack and the session started
  after that.
- **The self-check is the model grading itself.** Surviving questions are ones the same model
  answered consistently (`packs/generate.js`, `SELF_CHECK_*`). "0 dropped" means the model agreed
  with itself, not that the questions are right. Questions about a real course topic still need a
  human spot-check of the keys.
- **Only prepared topics work.** Generation takes minutes, so no request generates a pack: a real
  topic nobody prepared, or a nonsense string, is `404 topic_not_available` from
  `POST /session`. The topic gate (`topicSupported()` in `packs/generate.js`) runs at generation
  time only, which also means any pack already in the database is served without that check.
- **One topic family, text only.** No diagrams, no video, no uploads, no web search. A lesson is
  under 250 words plus one worked example.
- **A lesson claims from its sources or says it cannot.** When a pack has no sources for a
  concept, the lesson is prefixed with "General explanation:" and is explicitly unverified
  (`engine/lesson.js:UNCITED_NOTICE`). None of it is fact-checked.

## The learner model

- **Estimates are provisional evidence, not measurement.** `status` is a rule over events, not a
  psychometric estimate: two correct demonstrated events, a latest one that is not incorrect, and
  for curated packs at least one code-keyed event (`models/models.js`). Treat it as "what has been
  recorded", nothing more.
- **The weakest evidence wins.** A concept's `evidenceQuality` is the weakest quality among the
  events used (`weakestEvidenceQuality`), so one model-graded answer downgrades the label even
  next to code-keyed answers.
- **`unknown` is not a weakness.** It means nothing was assessed; the beta never infers a gap from
  silence, and never claims what a student does not understand — wording stays at "may"/"could".
- **A generated pack can never show `demonstrated`.** A4: only curated, code-keyed evidence says
  `demonstrated`; generated packs top out at `likely demonstrated`
  (`engine/session.js:certaintyFor`).
- **A short or skipped diagnostic is recorded as such** and reported as `lowEvidence`; the plan
  built from it is therefore weaker than it looks.

## Operations and safety

- **Accounts, and what they do not solve.** Auth is required: bcrypt password hashes, a JWT in an
  httpOnly cookie, and the roles `student`/`admin` (`controllers/auth.js`, `middleware/auth.js`).
  A student can read and delete only their own sessions; an admin can read any, and can change
  another account's role but not their own. There is still no password reset, no email verification,
  no session-expiry UI, and no retention policy beyond "the owner can delete a session, which deletes
  its evidence too" (`DELETE /sessions/:id`) and the operator teardown
  (`server/scripts/teardown.js`). No policy for minors — a first-year may be 17, so this must be
  resolved before any real use.
- **What is stored:** for an account, the name, email, bcrypt hash, role and creation time; for a
  session, the topic, the title, the goal text (40 characters max), which questions were answered;
  and one evidence event per concept per answer (with a short note). Not stored: IPs, or the answer
  text itself.
- **The only rate limit is one crude per-address window.** 60 requests a minute per address by
  default (`RATE_LIMIT_MAX` and `RATE_LIMIT_WINDOW_MS` raise or widen it for a room where several
  people share one address), over the whole API, swept in memory (`server/rate-limit.js`); past it
  the answer is `429 rate_limited` with a `Retry-After`. That is enough to stop one script burning the model queue,
  and not enough to stop a determined one: the count is per address (a campus behind one NAT
  shares an allowance, which is why the limit is generous), it is fixed-window rather than
  smoothed, and the address is `req.ip` — the client only because `app.js` sets `trust proxy 1`
  and the deployment publishes nothing but the proxy, so it is only as honest as that proxy. The JSON body is capped at 1 MB (`app.js`) and each answer at 4000 characters
  (`routes.js`). For a real deployment, put a proxy-side limit in front as well.
- **Prompt injection is contained, not solved.** Student and source text is wrapped in tags and
  declared data (`server/data-tags.js`), and closing tags are escaped everywhere a string enters a
  prompt (topic, goal, answer, why, source text). A model can still be talked into nonsense
  wording; it cannot write an estimate, a status, a confidence or an answer key, because the
  server validates and computes those.
- **Degraded is visible.** When the model is unreachable or replies with invalid JSON, the reply is
  server-written fallback text with `degraded: true`, or a `503 busy`. The UI says so rather than
  showing model text that does not exist.
- **No learning-outcome claim.** Nothing here has been compared against a plain chatbot, a
  tutor-prompted chatbot, NotebookLM, or a delayed post-test. There is no ethics approval and no
  frozen research build, so the beta cannot support a claim that students learn more.
- **Degraded responses are not recorded, so the dashboard cannot count them.** `degraded: true`
  goes to the client and is never stored, so `GET /admin/analytics/overview` reports
  `degradedRate: { recorded: false, rate: null }`. Any number there would be made up.
- **Analytics aggregates events, not understanding.** `outcomesByConcept` tallies all evidence in a
  topic (mastered ≥60% correct over 2+ graded events, struggling = incorrect ≥ correct, else
  emerging/unassessed). It is a cohort view of which concepts draw wrong answers, never a
  per-student verdict — those stay in the derived learner model, and stay provisional.

## Deployment

- **One process, one model.** `server/llm.js` streams through a single upstream and queues
  everything else; a demo with several people at once will see `503 busy`, not slower answers.
- **Strata must stay on localhost.** It holds the model and has no auth of its own in front of it
  in this setup. Only the proxy should be published (`docker-compose.yml`).
- **Pre-generated demo topics only.** A topic that needs generation at demo time waits minutes; a
  tunnel in front of the app answers 524 at about 100 s. See `docs/API_CONTRACT.md` for what a
  request may do.
