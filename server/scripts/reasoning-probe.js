// Read-only probe: does the Strata server honour reasoning: "off" (enable_thinking: false)
// versus reasoning: "low" (reasoning_effort) versus the server default?
// Reports latency, degraded flag and answer per mode so the caller can compare.
// Uses real self-check questions from a stored pack so answers are checkable.
require("dotenv").config();

const db = require("../config/db");
const { Pack } = require("../models/models");
const { chatJson } = require("../llm");
const { prompts, selfCheckResponseSchema } = require("../packs/generate");

function checkable(question) {
  if (question.kind !== "mcq" || !question.options || question.answerKey?.type !== "option") return null;
  const correctOptionIndex = question.options.indexOf(question.answerKey.value);
  if (correctOptionIndex < 0) return null;
  return { ...question, correctOptionIndex };
}

const MODES = [{ label: "off (enable_thinking: false)", reasoning: "off" },
  { label: "default (server decides)", reasoning: undefined },
  { label: "low (reasoning_effort: low)", reasoning: "low" }];
const REPS = 3;

async function timed(fn) {
  const started = process.hrtime.bigint();
  const value = await fn();
  return { value, ms: Number(process.hrtime.bigint() - started) / 1e6 };
}

async function main() {
  const topic = process.argv[2];
  if (!topic) {
    console.error('usage: node scripts/reasoning-probe.js "<topic with a stored pack>"');
    process.exitCode = 1;
    return;
  }
  await db.connect();
  const stored = await Pack.findOne({ topicKey: topic.trim().toLowerCase() }).lean();
  await db.disconnect();
  if (!stored?.pack) {
    console.error(`no stored pack for ${JSON.stringify(topic)}`);
    process.exitCode = 1;
    return;
  }

  const questions = [...stored.pack.diagnostic, ...stored.pack.check]
    .map(checkable).filter(Boolean).slice(0, 3);

  for (const question of questions) {
    console.log(`\nQ ${question.id}: ${question.prompt} (correct index ${question.correctOptionIndex})`);
    for (const mode of MODES) {
      const row = { label: mode.label, ms: [], degraded: 0, answers: [] };
      for (let rep = 0; rep < REPS; rep += 1) {
        const { value, ms } = await timed(() =>
          chatJson(
            prompts.selfCheckMessages({ question }),
            selfCheckResponseSchema,
            { answerIndex: -1 },
            { reasoning: mode.reasoning, maxTokens: 64 }
          )
        );
        row.ms.push(Math.round(ms));
        if (value.degraded) row.degraded += 1;
        row.answers.push(value.degraded ? null : value.value.answerIndex);
      }
      const avg = (row.ms.reduce((a, b) => a + b, 0) / row.ms.length).toFixed(0);
      console.log(`  ${mode.label}: avg ${avg}ms  degraded ${row.degraded}/${REPS}  answers ${row.answers.join(",")}`);
    }
  }
}

main().catch((e) => { console.error("FAILED:", e.message); process.exitCode = 1; });
