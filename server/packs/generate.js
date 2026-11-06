// Draft pack generation: { topic, goal, sourceChunks? } -> a validated pack with
// status "generated", stored in Mongo and cached by normalized topic.
//
// This file contains no topic content. It knows the pack SHAPE, not any subject.
// The LLM proposes concepts and questions; every reply is zod-validated, cross-checked
// with the Phase 0 pack validator, and multiple-choice answers are re-answered by the
// LLM without the key (self-consistency) before they are kept. Options are shuffled in
// code so neither a lazy key nor position guessing can pass, and more questions are
// drafted than needed because the check discards some.

const crypto = require("node:crypto");
const { z } = require("zod");
const { chatJson } = require("../llm");
const { validatePack } = require("./loader");
const { Pack } = require("../models/models");
const { MAX_TOPIC_LENGTH, InvalidTopicError, normalizeTopic } = require("./topic");
const MIN_CONCEPTS = 8;
const MAX_CONCEPTS = 14;
// Over-generation: each list is asked for more questions than the pack needs, because the
// self-check throws away the ones the model cannot answer consistently.
const QUESTIONS_PER_LIST = 8;
const MAX_QUESTIONS_PER_LIST = 10;
// Minimum questions per difficulty (1/2/3) in a draft. Slack at every tier means dropping a
// question cannot wipe out a tier and flatten the pack's difficulty ramp.
const MIN_QUESTIONS_PER_TIER = [2, 3, 3];
// A pack is mostly auto-gradable mcq: at least 2 mcq must survive per list, and a list may
// carry at most 2 free_text questions (they need an LLM to grade).
const MIN_SURVIVING_MCQ = 2;
const MAX_FREE_TEXT = 2;
const MIN_SURVIVING = 3; // per list, and one per difficulty tier
const TIERS = [1, 2, 3];
const PACK_VERSION = "0.1-beta";

class TopicNotSupportedError extends Error {
  constructor(message = "We could not build a reliable study pack for that topic. Try wording it differently.") {
    super(message);
    this.name = "TopicNotSupportedError";
    this.status = 422;
    this.code = "topic_not_supported";
    this.expose = true;
  }
}

// The model could not be reached at all. That is a broken dependency, not a bad topic, and it
// must never be reported as one or papered over with an invented pack.
class GenerationUnavailableError extends Error {
  constructor(message = "The study assistant is unavailable right now. Please try again shortly.") {
    super(message);
    this.name = "GenerationUnavailableError";
    this.status = 503;
    this.code = "generation_unavailable";
    this.expose = true;
  }
}

// ---------------------------------------------------------------------------
// Prompts. Everything a user typed is wrapped in a tag and named as data (rule 5).
// The tag defusal itself lives in data-tags.js so every prompt shares one copy.
// ---------------------------------------------------------------------------

const { DATA_NOTICE, asData, attribute } = require("../data-tags");

const CONCEPTS_SYSTEM = [
  "You design a curriculum draft for a study app. Reply with one JSON object and nothing else: no prose, no markdown fences.",
  DATA_NOTICE,
  "Rules for the concept graph:",
  `- Between ${MIN_CONCEPTS} and ${MAX_CONCEPTS} concepts.`,
  "- ids are lowercase snake_case, at most 40 characters, unique within the list.",
  "- Every prerequisite must be the id of another concept in the same list. Never reference anything outside the list.",
  "- The graph must be acyclic: no chain of prerequisites may lead back to the concept it started from.",
  "- Order the list from most basic to most advanced.",
  "- name is a few words. description is one sentence under 25 words saying what the concept is.",
  "- If source text is supplied, use it as the factual basis: keep to what it covers and add no fact it does not support.",
  "- If no source text is supplied, use your general knowledge of the subject. Never invent a citation, quotation, study or URL.",
  "- A topic is never refused for lack of sources: with no sources, describe it from general knowledge.",
].join("\n");

const QUESTIONS_SYSTEM = [
  "You write quiz questions for a study app. Reply with one JSON object and nothing else: no prose, no markdown fences.",
  DATA_NOTICE,
  "Rules for questions:",
  '- kind is "mcq" or "free_text".',
  '- "mcq": exactly 4 distinct options, and correctOptionIndex is the 0-based index of the single correct one. Wrong options must be plausible, not jokes.',
  '- "free_text": no options and no correctOptionIndex; give a rubric of one or two sentences describing what a full-credit answer must contain.',
  "- Vary the correct option's position between questions.",
  "- The prompt must not reveal or hint at the answer.",
  "- conceptIds may only use ids from the supplied concept list, 1 to 3 per question.",
  '- feedback.correct and feedback.incorrect are one short sentence each. When describing a likely mistake, say "may" or "could"; never state what the student does not understand.',
  "- If source text is supplied, use it as the factual basis: keep to what it covers and add no fact it does not support.",
  "- If no source text is supplied, use your general knowledge of the subject. Never invent a citation, quotation, study or URL.",
  "- A topic is never refused for lack of sources: with no sources, write the questions from general knowledge.",
].join("\n");

const SELF_CHECK_SYSTEM = [
  "You answer multiple-choice questions. Reply with one JSON object and nothing else. Do not explain.",
  DATA_NOTICE,
  "Answer from your own knowledge of the subject. If you are unsure, still pick the single best index.",
].join("\n");

// The cheapest question we can ask before spending minutes on a pack: is this a subject at all?
// Generation is the only expensive path in the beta, and a phrase that names nothing would burn
// five minutes to end in topic_not_supported anyway.
const TOPIC_CHECK_SYSTEM = [
  "You decide whether a phrase names a subject that can be taught and quizzed. Reply with one JSON object and nothing else: no prose, no markdown fences.",
  DATA_NOTICE,
  "supported=true when the phrase names a real, learnable subject: an academic subject, a skill, a technique, a tool, a work, or a body of knowledge.",
  "supported=false when it is nonsense or random characters, a bare instruction or question, a request about you or this app, or so vague that it names no single subject.",
  "Do not judge fame, level or difficulty: an unusual or very narrow subject is still true if a person could study it.",
  "When the phrase is ambiguous, answer true. Rejecting a real subject is worse than attempting it.",
].join("\n");

function topicCheckMessages({ topic }) {
  return [
    { role: "system", content: TOPIC_CHECK_SYSTEM },
    {
      role: "user",
      content: [
        `<topic>${asData(topic)}</topic>`,
        "",
        "Does this name a subject a person could study?",
        'Reply as {"supported": true} or {"supported": false}.',
      ].join("\n"),
    },
  ];
}

function sourceBlock(sources) {
  if (!sources.length) {
    return (
      "No source text was supplied. Use your general knowledge of the subject. " +
      "Do not invent citations, quotations, studies or URLs, and do not refuse the topic for lack of sources."
    );
  }
  const body = sources
    .map(
      (source) =>
        `<source id="${attribute(source.id)}" title="${attribute(source.title)}">\n${asData(source.text)}\n</source>`
    )
    .join("\n");
  return (
    "The student supplied this source text. Use only it as the factual basis: " +
    `keep to what it covers, add no fact it does not support, and cite nothing beyond it.\n${body}`
  );
}

function conceptsMessages({ topic, goal, sources }) {
  return [
    { role: "system", content: CONCEPTS_SYSTEM },
    {
      role: "user",
      content: [
        `<topic>${asData(topic)}</topic>`,
        `<goal>${asData(goal)}</goal>`,
        sourceBlock(sources),
        "",
        `Return between ${MIN_CONCEPTS} and ${MAX_CONCEPTS} concepts as:`,
        '{"concepts":[{"id":"lowercase_snake_case","name":"short name","description":"one sentence","prerequisites":["id_of_another_concept"]}]}',
        "Every prerequisite id must be an id in this same list. At least one concept must have no prerequisites.",
      ].join("\n"),
    },
  ];
}

function questionsMessages({ topic, goal, sources, concepts }) {
  const conceptList = concepts.map((concept) => ({ id: concept.id, name: concept.name }));
  return [
    { role: "system", content: QUESTIONS_SYSTEM },
    {
      role: "user",
      content: [
        `<topic>${asData(topic)}</topic>`,
        `<goal>${asData(goal)}</goal>`,
        `<concept_list>${asData(JSON.stringify(conceptList))}</concept_list>`,
        sourceBlock(sources),
        "",
        `Produce ${QUESTIONS_PER_LIST} diagnostic questions and ${QUESTIONS_PER_LIST} check questions (never more than ${MAX_QUESTIONS_PER_LIST} in a list).`,
        `Each list: at least ${MIN_QUESTIONS_PER_TIER[0]} at difficulty 1, at least ${MIN_QUESTIONS_PER_TIER[1]} at difficulty 2, at least ${MIN_QUESTIONS_PER_TIER[2]} at difficulty 3.`,
        "Diagnostic questions: transfer false and requiresWhy false.",
        "Check questions: every difficulty-2 question has requiresWhy true and a rubric for the explanation; every difficulty-3 question has transfer true, applying the idea to a situation the student has not seen; every other check question has transfer false.",
        'Each list has at least one and at most two "free_text" questions; the rest are "mcq". Omit fields that do not apply to the question kind.',
        "",
        "Return:",
        '{"diagnostic":[{"id":"...","kind":"mcq|free_text","prompt":"...","options":["a","b","c","d"],"correctOptionIndex":0,"conceptIds":["id"],"difficulty":1,"transfer":false,"requiresWhy":false,"rubric":"...","feedback":{"correct":"...","incorrect":"..."}}],"check":[...]}',
      ].join("\n"),
    },
  ];
}

// Deliberately contains no key, no correctness flag and no feedback: the model must
// answer the question from scratch for the check to mean anything.
function selfCheckMessages({ question }) {
  const options = question.options.map((option, index) => `${index}. ${asData(option)}`).join("\n");
  return [
    { role: "system", content: SELF_CHECK_SYSTEM },
    {
      role: "user",
      content: [
        `<question>${asData(question.prompt)}</question>`,
        `<options>\n${options}\n</options>`,
        "",
        "Which single option index is correct?",
        '{"answerIndex":0}',
      ].join("\n"),
    },
  ];
}

const prompts = { conceptsMessages, questionsMessages, selfCheckMessages, topicCheckMessages };

// ---------------------------------------------------------------------------
// Schemas (rule 2: every LLM reply is zod-validated)
// ---------------------------------------------------------------------------

const conceptsResponseSchema = z.object({
  concepts: z
    .array(
      z.object({
        id: z.string().min(1).max(80),
        name: z.string().min(1).max(160),
        description: z.string().min(1).max(400),
        prerequisites: z.array(z.string().min(1).max(80)).max(8),
      })
    )
    .min(MIN_CONCEPTS)
    .max(MAX_CONCEPTS),
});

const questionDraftSchema = z.object({
  id: z.string().min(1).max(80),
  kind: z.enum(["mcq", "free_text"]),
  prompt: z.string().min(10).max(600),
  options: z.array(z.string().min(1).max(300)).length(4).optional(),
  correctOptionIndex: z.number().int().min(0).max(3).optional(),
  conceptIds: z.array(z.string().min(1)).min(1).max(3),
  difficulty: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  transfer: z.boolean(),
  requiresWhy: z.boolean(),
  rubric: z.string().min(10).max(1000).optional(),
  feedback: z.object({
    correct: z.string().min(1).max(400),
    incorrect: z.string().min(1).max(400),
  }),
});

const questionsResponseSchema = z.object({
  diagnostic: z.array(questionDraftSchema).min(QUESTIONS_PER_LIST).max(MAX_QUESTIONS_PER_LIST),
  check: z.array(questionDraftSchema).min(QUESTIONS_PER_LIST).max(MAX_QUESTIONS_PER_LIST),
});

const selfCheckResponseSchema = z.object({ answerIndex: z.number().int().min(0).max(3) });

// One boolean back, so the cap only has to cover `{"supported": true}`. Measured like the
// self-check cap: see scripts/bench-topic-check.js.
const topicCheckResponseSchema = z.object({ supported: z.boolean() });

// ---------------------------------------------------------------------------
// Normalization and structural checks
// ---------------------------------------------------------------------------

function slug(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

// Concept ids are engine-facing, so they are normalized. Prerequisites may be written as
// ids or names by the model; both resolve to the same normalized id. Anything that still
// does not resolve is left as-is so the pack validator reports it.
function normalizeConcepts(rawConcepts) {
  const ids = rawConcepts.map((concept, index) => slug(concept.id) || slug(concept.name) || `concept_${index + 1}`);
  const aliases = new Map();
  rawConcepts.forEach((concept, index) => {
    for (const alias of [concept.id, concept.name]) {
      for (const key of [String(alias || "").trim(), slug(alias)]) {
        if (key && !aliases.has(key)) aliases.set(key, ids[index]);
      }
    }
  });

  const resolve = (reference) =>
    aliases.get(String(reference || "").trim()) || aliases.get(slug(reference)) || slug(reference);

  return rawConcepts.map((concept, index) => ({
    id: ids[index],
    name: concept.name.trim(),
    description: concept.description.trim(),
    // No filtering or de-duplication of cycles here: a self-referencing or circular
    // prerequisite is a real defect and must reach the validator.
    prerequisites: [...new Set(concept.prerequisites.map(resolve))],
  }));
}

// A pack-shaped object with no questions, so the Phase 0 validator can check the graph.
function conceptSkeleton({ topic, concepts, sources }) {
  return {
    packId: packIdFor(topic),
    topic,
    status: "generated",
    version: PACK_VERSION,
    concepts,
    diagnostic: [],
    check: [],
    traces: {},
    sources,
  };
}

function packIdFor(topicKey) {
  return `generated-${crypto.createHash("sha256").update(topicKey).digest("hex").slice(0, 12)}`;
}

// Structural rules for a freshly drafted question list. This is stricter than the pack
// schema on purpose: it is what the phase asks the model for, so a sloppy draft is retried.
function draftErrors(list, section, conceptIds) {
  const errors = [];

  for (const [index, question] of list.entries()) {
    const at = `${section}[${index}]`;

    for (const conceptId of question.conceptIds) {
      if (!conceptIds.has(conceptId)) errors.push(`${at}: conceptId "${conceptId}" is not in the concept graph`);
    }

    if (question.kind === "mcq") {
      if (!question.options) errors.push(`${at}: mcq has no options`);
      else {
        if (new Set(question.options).size !== 4) errors.push(`${at}: mcq options must be distinct`);
        if (question.correctOptionIndex === undefined) errors.push(`${at}: mcq has no correctOptionIndex`);
      }
      if (question.rubric === undefined && question.requiresWhy) {
        errors.push(`${at}: mcq requiring a why must carry a rubric`);
      }
    } else if (question.rubric === undefined) {
      errors.push(`${at}: free_text has no rubric`);
    }
  }

  const tiers = TIERS.map((tier) => list.filter((question) => question.difficulty === tier).length);
  tiers.forEach((count, index) => {
    const minimum = MIN_QUESTIONS_PER_TIER[index];
    if (count < minimum) {
      errors.push(`${section}: needs at least ${minimum} questions at difficulty ${index + 1}, got ${count}`);
    }
  });

  for (const question of list) {
    if (section === "check") {
      const wantsTransfer = question.difficulty === 3;
      if (question.transfer !== wantsTransfer) {
        errors.push(`${section}: only difficulty-3 questions are transfer questions`);
      }
      const wantsWhy = question.difficulty === 2;
      if (question.requiresWhy !== wantsWhy) {
        errors.push(`${section}: only difficulty-2 questions require a why`);
      }
      if (wantsWhy && question.rubric === undefined) {
        errors.push(`${section}: the requiresWhy question has no rubric`);
      }
    } else if (question.transfer || question.requiresWhy) {
      errors.push(`${section}: diagnostic questions are neither transfer nor why questions`);
    }
  }

  const freeTextCount = list.filter((question) => question.kind === "free_text").length;
  if (freeTextCount === 0) errors.push(`${section}: no free_text question`);
  if (freeTextCount > MAX_FREE_TEXT) {
    errors.push(`${section}: at most ${MAX_FREE_TEXT} free_text questions, got ${freeTextCount}`);
  }

  return errors;
}

// Option order from the model means nothing, and a model that always puts the right answer
// first would leak the key and reward position guessing. Each mcq is shuffled in code, before
// the self-check, so the check sees exactly the order the student will see. The key follows
// its option text.
function shuffleOptions(question) {
  if (question.kind !== "mcq" || !question.options) return question;

  const order = question.options.map((option, index) => ({ option, index }));
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }

  return {
    ...question,
    options: order.map((entry) => entry.option),
    correctOptionIndex: order.findIndex((entry) => entry.index === question.correctOptionIndex),
  };
}

// Question ids are engine-facing, so they are assigned here (d1..dN, c1..cN).
function toPackQuestion(question, id) {
  const packQuestion = {
    id,
    kind: question.kind,
    prompt: question.prompt.trim(),
    conceptIds: question.conceptIds,
    difficulty: question.difficulty,
    transfer: question.transfer,
    requiresWhy: question.requiresWhy,
    answerKey:
      question.kind === "mcq"
        ? { type: "option", value: question.options[question.correctOptionIndex] }
        : null,
    fallbackFeedback: question.feedback,
  };
  if (question.options) packQuestion.options = question.options;
  if (question.rubric) packQuestion.rubric = question.rubric.trim();
  return packQuestion;
}

function survivalErrors(diagnostic, check) {
  const errors = [];
  const lists = [
    ["diagnostic", diagnostic],
    ["check", check],
  ];

  for (const [section, list] of lists) {
    if (list.length < MIN_SURVIVING) {
      errors.push(`only ${list.length} ${section} questions survived, ${MIN_SURVIVING} are needed`);
    }
    const mcqCount = list.filter((question) => question.kind !== "free_text").length;
    if (mcqCount < MIN_SURVIVING_MCQ) {
      errors.push(`only ${mcqCount} ${section} mcq survived, ${MIN_SURVIVING_MCQ} are needed`);
    }
    if (list.filter((question) => question.kind === "free_text").length > MAX_FREE_TEXT) {
      errors.push(`more than ${MAX_FREE_TEXT} ${section} free_text questions survived`);
    }
    for (const tier of TIERS) {
      if (!list.some((question) => question.difficulty === tier)) {
        errors.push(`no ${section} question at difficulty ${tier} survived`);
      }
    }
  }

  return errors;
}

// A5: pasted source text has no web provenance. Chunks keep the caller's id (S1, S2 ...)
// and get a urn: rather than a made-up URL, so nothing pretends to be a real source.
function toSources(sourceChunks) {
  if (!Array.isArray(sourceChunks)) return [];
  return sourceChunks
    .slice(0, 40)
    .map((chunk, index) => {
      const id = String(chunk.id || `S${index + 1}`);
      return {
        id,
        title: String(chunk.title || `Pasted source ${id}`),
        url: String(chunk.url || `urn:clario:pasted:${id}`),
        license: String(chunk.license || "unknown"),
        text: String(chunk.text || "").trim(),
      };
    })
    .filter((source) => source.text);
}

// ---------------------------------------------------------------------------
// Storage and cache
// ---------------------------------------------------------------------------

const mongoStore = {
  async findByTopicKey(topicKey) {
    const document = await Pack.findOne({ topicKey }).lean();
    return document ? document.pack : null;
  },
  async save({ topicKey, topic, pack }) {
    try {
      await Pack.create({ topicKey, topic, pack });
      return pack;
    } catch (error) {
      if (error.code === 11000) {
        // Two requests generated the same topic at once: keep the first one stored.
        const existing = await Pack.findOne({ topicKey }).lean();
        if (existing) return existing.pack;
      }
      throw error;
    }
  },
};

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

// The self-check answer is `{"answerIndex":0}`. Thinking is switched off for it (llm.js
// `reasoning: "off"`), so a small cap is enough — but if a server ignores that switch, thinking
// would eat the cap and the question would be dropped, so this is measured, not guessed.
const SELF_CHECK_MAX_TOKENS = 64;

// The topic check answers one boolean, so its cap is smaller still. Measured the same way, with
// scripts/bench-topic-check.js: the cap is what a wrong answer would have to fit in, so it is
// checked against the real server rather than assumed.
const TOPIC_CHECK_MAX_TOKENS = 32;

const TOPIC_CHECK_MESSAGE =
  "That does not look like a subject we can build a study pack for. Name a subject, skill or " +
  "technique — something a person could study or practise.";

// One validated LLM reply. null means the reply was unusable, which a retry may fix.
// "Could not reach the model" is thrown instead: that is a broken dependency, not a bad topic.
async function askJson(chatJsonFn, messages, schema, fallback, options = {}) {
  const { value, degraded, reason } = await chatJsonFn(messages, schema, fallback, {
    json: true,
    ...options,
  });
  if (!degraded) return value;
  if (reason === "unavailable") throw new GenerationUnavailableError();
  return null;
}

// The gate before any drafting: one call, thinking off, one boolean back. A phrase that names no
// subject is refused here rather than five minutes into a generation run. An unusable reply is a
// refusal too (the reply is the whole evidence we have), but an unreachable model is not: that is
// a broken dependency and askJson throws GenerationUnavailableError for it.
async function topicSupported({ topic, chatJsonFn }) {
  const value = await askJson(
    chatJsonFn,
    topicCheckMessages({ topic }),
    topicCheckResponseSchema,
    { supported: false },
    { reasoning: "off", maxTokens: TOPIC_CHECK_MAX_TOKENS }
  );
  return value !== null && value.supported === true;
}

async function draftConcepts({ topic, goal, sources, chatJsonFn }) {
  // Thinking off, like the gate and the self-check: this model thinks by default, and a
  // thinking draft of a dozen concepts can run past the stream timeout and lose the whole
  // generation. Measured against the real server (scripts/bench-*.js pattern): off answers
  // in ~13 s where the default takes ~60 s. No maxTokens cap — the reply is the whole list.
  const value = await askJson(
    chatJsonFn,
    conceptsMessages({ topic, goal, sources }),
    conceptsResponseSchema,
    { concepts: [] },
    { reasoning: "off" }
  );
  if (!value) return null;

  const concepts = normalizeConcepts(value.concepts);
  const { valid } = validatePack(conceptSkeleton({ topic, concepts, sources }));
  return valid ? concepts : null;
}

async function draftQuestions({ topic, goal, sources, concepts, conceptIds, chatJsonFn }) {
  // Thinking off for the same reason as the concepts draft, and more so: this is the largest
  // reply in the generation, and with the server's thinking default its stream does not
  // finish inside the timeout at all — the run fails with generation_unavailable before any
  // question exists. Off completes in about a minute with the full list.
  const value = await askJson(
    chatJsonFn,
    questionsMessages({ topic, goal, sources, concepts }),
    questionsResponseSchema,
    { diagnostic: [], check: [] },
    { reasoning: "off" }
  );
  if (!value) return null;

  const diagnosticErrors = draftErrors(value.diagnostic, "diagnostic", conceptIds);
  const checkErrors = draftErrors(value.check, "check", conceptIds);
  if (diagnosticErrors.length || checkErrors.length) return null;

  return {
    diagnostic: value.diagnostic.map((question, index) => ({ ...shuffleOptions(question), id: `d${index + 1}` })),
    check: value.check.map((question, index) => ({ ...shuffleOptions(question), id: `c${index + 1}` })),
  };
}

// Step 4: ask the model to answer each mcq without the key; keep it only if it agrees.
async function consistentMcq(question, chatJsonFn) {
  const value = await askJson(
    chatJsonFn,
    selfCheckMessages({ question }),
    selfCheckResponseSchema,
    { answerIndex: -1 },
    { reasoning: "off", maxTokens: SELF_CHECK_MAX_TOKENS }
  );
  return value !== null && value.answerIndex === question.correctOptionIndex;
}

// llm.js runs 2 requests at a time and queues 3. Self-checking in batches of 2 therefore never
// queues behind itself, while a batch of 16 would throw LlmBusyError against our own work.
const SELF_CHECK_BATCH = 2;

async function mapWithLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function keepConsistent({ diagnostic, check, chatJsonFn }) {
  const questions = [...diagnostic, ...check];
  const kept = await mapWithLimit(questions, SELF_CHECK_BATCH, async (question) => {
    if (question.kind !== "mcq") return true; // a free_text question has no key to contradict
    return consistentMcq(question, chatJsonFn);
  });

  const survivors = new Set(questions.filter((question, index) => kept[index]));
  const surviving = {
    diagnostic: diagnostic.filter((question) => survivors.has(question)),
    check: check.filter((question) => survivors.has(question)),
  };
  return {
    ...surviving,
    dropped: {
      diagnostic: diagnostic.length - surviving.diagnostic.length,
      check: check.length - surviving.check.length,
    },
  };
}

// Draft a full question list, then keep only what survives the self-check. A null `surviving`
// means the attempt produced nothing usable, so the caller retries once. The counts travel
// with it so a caller can show how many questions the check threw away.
async function draftSurvivingQuestions({ topic, goal, sources, concepts, conceptIds, chatJsonFn }) {
  const draft = await draftQuestions({ topic, goal, sources, concepts, conceptIds, chatJsonFn });
  if (!draft) return { surviving: null, drafted: null, dropped: null };

  const surviving = await keepConsistent({ ...draft, chatJsonFn });
  const stats = {
    drafted: { diagnostic: draft.diagnostic.length, check: draft.check.length },
    dropped: surviving.dropped,
  };
  if (survivalErrors(surviving.diagnostic, surviving.check).length) {
    return { surviving: null, ...stats };
  }
  return { surviving, ...stats };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function generatePack({ topic, goal = "", sourceChunks = [], deps = {} } = {}) {
  const normalizedTopic = normalizeTopic(topic);
  const topicKey = normalizedTopic.toLowerCase();
  const store = deps.store || mongoStore;
  const chatJsonFn = deps.chatJson || chatJson;

  const cached = await store.findByTopicKey(topicKey);
  if (cached) return { pack: cached, cached: true, stats: null };

  const sources = toSources(sourceChunks);
  const studentGoal = String(goal || "").slice(0, 40);

  // Step 0. Is this a subject at all? One cheap call, before anything is drafted. A pack that
  // already exists was returned above, so an existing topic is never re-gated.
  if (!(await topicSupported({ topic: normalizedTopic, chatJsonFn }))) {
    throw new TopicNotSupportedError(TOPIC_CHECK_MESSAGE);
  }

  // Step 1 + 2. Concepts, then the Phase 0 validator. One retry, then give up.
  let concepts = null;
  for (let attempt = 1; attempt <= 2 && !concepts; attempt += 1) {
    concepts = await draftConcepts({ topic: normalizedTopic, goal: studentGoal, sources, chatJsonFn });
  }
  if (!concepts) throw new TopicNotSupportedError();

  const conceptIds = new Set(concepts.map((concept) => concept.id));

  // Step 3 + 4. Questions, then self-consistency. The attempt is retried as a whole, because
  // what matters is what SURVIVES the check, not what was drafted. After the retry, a draft
  // that cannot keep the floor (3 per list, 2 mcq per list, one per tier) means the topic is
  // not supported. Counts are summed across attempts so the caller can show the real cost.
  let surviving = null;
  const stats = {
    attempts: 0,
    drafted: { diagnostic: 0, check: 0 },
    dropped: { diagnostic: 0, check: 0 },
  };

  for (let attempt = 1; attempt <= 2 && !surviving; attempt += 1) {
    const result = await draftSurvivingQuestions({
      topic: normalizedTopic,
      goal: studentGoal,
      sources,
      concepts,
      conceptIds,
      chatJsonFn,
    });

    stats.attempts = attempt;
    if (result.drafted) {
      for (const section of ["diagnostic", "check"]) {
        stats.drafted[section] += result.drafted[section];
        stats.dropped[section] += result.dropped[section];
      }
    }
    surviving = result.surviving;
  }
  if (!surviving) throw new TopicNotSupportedError();

  const pack = {
    packId: packIdFor(topicKey),
    topic: normalizedTopic,
    status: "generated",
    version: PACK_VERSION,
    concepts,
    diagnostic: surviving.diagnostic.map((question) => toPackQuestion(question, question.id)),
    check: surviving.check.map((question) => toPackQuestion(question, question.id)),
    traces: {},
    sources,
  };

  // Final gate: the pack the app will actually serve must pass the same validator.
  const { valid } = validatePack(pack);
  if (!valid) throw new TopicNotSupportedError();

  const stored = await store.save({ topicKey, topic: normalizedTopic, pack });
  return { pack: stored, cached: false, stats };
}

module.exports = {
  generatePack,
  normalizeTopic,
  toSources,
  prompts,
  // Exported for the self-check benchmark (scripts/bench-selfcheck.js): it must measure the real
  // prompt, schema and call options rather than a copy of them that could drift.
  selfCheckResponseSchema,
  consistentMcq,
  mapWithLimit,
  SELF_CHECK_BATCH,
  SELF_CHECK_MAX_TOKENS,
  // Exported for scripts/bench-topic-check.js, for the same reason.
  topicSupported,
  topicCheckResponseSchema,
  TOPIC_CHECK_MAX_TOKENS,
  TopicNotSupportedError,
  InvalidTopicError,
  GenerationUnavailableError,
  MAX_TOPIC_LENGTH,
};
