// How much the self-check's `reasoning: "off"` switch is worth, and how parallel it can go.
// Run from server/: node scripts/bench-selfcheck.js ["Binary search"]
//
// Two measurements against the real model, using the real prompt, schema and call options:
//
//   1. One self-check question, thinking off versus the server default. Same question, same
//      prompt, same 64-token cap, only `reasoning` differs, one call at a time so the figures are
//      per-call latency rather than throughput.
//   2. The whole mcq set of one stored pack at concurrency 2, 3 and 4, via the same
//      `mapWithLimit` the generator uses. llm.js runs 2 requests at a time and queues 3, so a
//      limit above 5 would fail against our own queue rather than tell us anything.
//
// The questions come from a pack that was already generated: their options were shuffled when the
// pack was built, so the keyed index is the real one the self-check would have to find.

require("dotenv").config();

const db = require("../config/db");
const { chatJson } = require("../llm");
const { Pack } = require("../models/models");
const {
  consistentMcq,
  mapWithLimit,
  prompts,
  selfCheckResponseSchema,
  SELF_CHECK_BATCH,
  SELF_CHECK_MAX_TOKENS,
} = require("../packs/generate");

// Exactly what consistentMcq sends, and exactly what it would send without the switch.
const THINKING_OFF = { json: true, reasoning: "off", maxTokens: SELF_CHECK_MAX_TOKENS };
const THINKING_DEFAULT = { json: true, maxTokens: SELF_CHECK_MAX_TOKENS };

// A pack's stored questions carry the key as the option text, because the options were shuffled
// before the pack was built. The self-check compares an index, so the text is resolved back to one.
function checkable(question) {
  if (question.kind !== "mcq" || !question.options || question.answerKey?.type !== "option") return null;
  const correctOptionIndex = question.options.indexOf(question.answerKey.value);
  if (correctOptionIndex < 0) return null;
  return { ...question, correctOptionIndex };
}

async function timed(fn) {
  const started = process.hrtime.bigint();
  const value = await fn();
  return { value, ms: Number(process.hrtime.bigint() - started) / 1e6 };
}

function seconds(ms) {
  return `${(ms / 1000).toFixed(2)}s`;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// One self-check call, reported as an answer rather than a verdict so a wrong answer is visible
// instead of looking like a fast success.
async function selfCheckOnce(question, options) {
  const { value, ms } = await timed(() =>
    chatJson(
      prompts.selfCheckMessages({ question }),
      selfCheckResponseSchema,
      { answerIndex: -1 },
      options
    )
  );
  const agree = !value.degraded && value.value.answerIndex === question.correctOptionIndex;
  return { ms, agree, answerIndex: value.degraded ? null : value.value.answerIndex };
}

async function measureSwitch(questions, samples) {
  const rows = [];
  for (const question of questions.slice(0, samples)) {
    const off = await selfCheckOnce(question, THINKING_OFF);
    const byDefault = await selfCheckOnce(question, THINKING_DEFAULT);
    rows.push({ id: question.id, off, byDefault });
    console.log(
      `  ${question.id}\toff ${seconds(off.ms)}\tdefault ${seconds(byDefault.ms)}\t` +
        `off agreed=${off.agree} default agreed=${byDefault.agree}`
    );
  }
  const offMedian = median(rows.map((row) => row.off.ms));
  const defaultMedian = median(rows.map((row) => row.byDefault.ms));
  console.log(
    `  median\toff ${seconds(offMedian)}\tdefault ${seconds(defaultMedian)}\t` +
      `${(defaultMedian / offMedian).toFixed(1)}x slower\n`
  );
  return { offMedian, defaultMedian };
}

// The whole set, the same way, at one concurrency each time.
async function measureBatch(questions, limit) {
  const { value, ms } = await timed(() =>
    mapWithLimit(questions, limit, (question) => consistentMcq(question, chatJson))
  );
  const kept = value.filter(Boolean).length;
  console.log(
    `  limit ${limit}\t${seconds(ms)}\tkept ${kept}/${questions.length}\t` +
      `${(ms / questions.length).toFixed(0)}ms per question`
  );
  return ms;
}

async function main() {
  const topic = process.argv[2] || "Binary search";
  await db.connect();

  const stored = await Pack.findOne({ topicKey: topic.trim().toLowerCase() }).lean();
  if (!stored?.pack) {
    console.error(`no stored pack for "${topic}" — run npm run generate:preview first`);
    process.exitCode = 1;
    return;
  }

  const { pack } = stored;
  const questions = [...pack.diagnostic, ...pack.check].map(checkable).filter(Boolean);
  if (!questions.length) {
    console.error(`pack ${pack.packId} has no checkable mcq`);
    process.exitCode = 1;
    return;
  }

  console.log(`pack ${pack.packId} ("${pack.topic}"), ${questions.length} mcq self-checks\n`);
  console.log(`reasoning off vs server default (${SELF_CHECK_MAX_TOKENS}-token cap, one call at a time)`);
  await measureSwitch(questions, 3);

  console.log(`whole set through mapWithLimit (production batch is ${SELF_CHECK_BATCH})`);
  for (const limit of [2, 3, 4]) await measureBatch(questions, limit);
}

main()
  .catch((error) => {
    console.error(`failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => db.disconnect());
