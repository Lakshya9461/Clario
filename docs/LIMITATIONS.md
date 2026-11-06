# Clario beta: what this build does not do

The beta is a demo of the engine, not a study tool you can rely on yet. Each limitation below is
verified against the code, with the file that causes it.

## Content

- **Generated packs are unreviewed.** A pack for a topic nobody curated is written by the model
  (`server/packs/generate.js`) and stored as-is once it passes schema validation, graph checks and
  the self-check. No human reads the questions or the answer keys. Curated packs live in
  `server/packs/*.json` and there is one of them (`sample-topic-a.json`).
- **A generated pack's answer keys are the model's own.** They are graded in code, exactly, but
  the key itself came from the model, so `evidenceQuality` is `llm_keyed`, never `code_keyed`
  (`engine/grading.js:keyedQuality`).
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

- **No accounts and no retention policy.** A session id is a Mongo ObjectId in `localStorage`;
  anyone with the id can read the session. Data is kept until an operator deletes it with
  `server/scripts/teardown.js`. There is no user-facing deletion, no cross-session history, and no
  policy for minors — a first-year may be 17, so this must be resolved before any real use.
- **What is stored:** the topic, the goal text (40 characters max), which questions were answered,
  and one evidence event per concept per answer (with a short note). Not stored: names, emails,
  IPs, or the answer text itself.
- **No rate limiting.** The server caps the JSON body at 1 MB (`app.js`) and each answer at 4000
  characters (`routes.js`), and the LLM queue refuses work past 2 in flight plus 3 waiting
  (`503 busy`), which is the only back-pressure there is. There is no per-IP or per-session limit,
  so a public deployment can be hammered. Put a proxy limit in front before exposing it.
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

## Deployment

- **One process, one model.** `server/llm.js` streams through a single upstream and queues
  everything else; a demo with several people at once will see `503 busy`, not slower answers.
- **Strata must stay on localhost.** It holds the model and has no auth of its own in front of it
  in this setup. Only the proxy should be published (`docker-compose.yml`).
- **Pre-generated demo topics only.** A topic that needs generation at demo time waits minutes; a
  tunnel in front of the app answers 524 at about 100 s. See `docs/API_CONTRACT.md` for what a
  request may do.
