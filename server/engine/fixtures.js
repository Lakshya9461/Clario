// Test fixtures: one pack shape and one fake model, shared by the engine and route tests.
//
// Not a *.test.js file, so `node --test` does not run it on its own. The content is deliberately
// subject-free, exactly like real packs are for the engine: "Part 1" has no meaning, which is what
// proves the engine never needs one.

const mongoose = require("mongoose");

function mcq(id, difficulty, extra = {}) {
  return {
    id,
    kind: "mcq",
    prompt: `Which statement about ${id} is correct?`,
    options: ["option a", "option b", "option c", "option d"],
    conceptIds: ["part_1"],
    difficulty,
    transfer: false,
    requiresWhy: false,
    answerKey: { type: "option", value: "option b" },
    rubric: `A full-credit answer selects option b for ${id}.`,
    fallbackFeedback: { correct: "That is right.", incorrect: "That is not the right option." },
    ...extra,
  };
}

function freeText(id, difficulty, extra = {}) {
  return {
    id,
    kind: "free_text",
    prompt: `Explain what ${id} means in one sentence.`,
    conceptIds: ["part_2"],
    difficulty,
    transfer: false,
    requiresWhy: false,
    answerKey: null,
    rubric: "A full-credit answer names the idea and says what it does.",
    fallbackFeedback: { correct: "That covers it.", incorrect: "That does not cover the idea yet." },
    ...extra,
  };
}

function makePack(overrides = {}) {
  const concepts = Array.from({ length: 8 }, (_, index) => {
    const n = index + 1;
    return {
      id: `part_${n}`,
      name: `Part ${n}`,
      description: `Concept number ${n} of this topic.`,
      prerequisites: n === 1 ? [] : [`part_${n - 1}`],
    };
  });

  return {
    packId: "sample-1",
    topic: "Sample Topic",
    status: "curated",
    version: "1.0.0",
    concepts,
    diagnostic: [
      mcq("d1", 1),
      mcq("d2", 2),
      mcq("d3", 3),
      mcq("d4", 1),
      mcq("d5", 2),
    ],
    check: [
      mcq("c1", 1),
      mcq("c2", 2, { requiresWhy: true }),
      mcq("c3", 3, { transfer: true }),
    ],
    traces: {},
    sources: [
      {
        id: "s1",
        title: "Source One",
        url: "https://example.test/one",
        license: "CC0",
        text: "Part 1 is about the first idea in this topic.",
      },
    ],
    ...overrides,
  };
}

function makeSession(pack, overrides = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    topic: pack.topic,
    packId: pack.packId,
    packStatus: pack.status,
    goal: "exam",
    answeredQuestionIds: [],
    skippedDiagnosis: false,
    ...overrides,
  };
}

// A fake model that answers the four prompts this app sends, and records what it was asked.
// `replies` overrides any one of them. Dispatch is on the system prompt, so a test never has to
// count calls.
function makeFakeChat(replies = {}) {
  const calls = [];
  const fn = async (messages, schema, fallback, options) => {
    const system = String(messages[0].content);
    const chatOptions = options || {};
    const user = String(messages.at(-1).content);
    calls.push({ system, user, options: chatOptions });

    const degraded = (reply) =>
      replies.degraded ? { value: fallback, degraded: true } : { value: reply, degraded: false };

    if (system.includes("You grade a short written answer")) {
      return degraded(
        replies.grade ?? {
          concepts: [{ conceptId: "part_2", outcome: "correct", note: "Named the idea." }],
        }
      );
    }
    if (system.includes("You write feedback")) {
      return degraded(replies.feedback ?? { feedback: "That is right.", whyOutcome: null });
    }
    if (system.includes("You explain a study plan")) {
      return degraded(
        replies.plan ?? {
          objective: "Be able to apply the topic.",
          findings: [],
          steps: [],
        }
      );
    }
    if (system.includes("You teach one concept")) {
      return degraded(
        replies.lesson ?? {
          markdown: "## Lesson\n\nA short explanation.",
          usedSourceIds: ["s1"],
          workedExample: "A solved example.",
        }
      );
    }
    throw new Error(`unexpected prompt: ${system.slice(0, 40)}`);
  };
  return { fn, calls };
}

module.exports = { makePack, makeSession, makeFakeChat, mcq, freeText };
