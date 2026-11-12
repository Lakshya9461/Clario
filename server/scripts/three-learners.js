#!/usr/bin/env node
// Local demo driver: three learners, three different plans. Run against a live API, from
// server/: node scripts/three-learners.js [apiUrl] [topic]. Learner actions always go through
// the public API. The backing pack is
// read only to simulate known correct answers because the API deliberately hides answer keys;
// evidence is read only to report quality and verify that the plan's status matches the engine.

const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const dotenv = require("dotenv");

dotenv.config({ path: path.join(__dirname, "..", ".env") });

const db = require("../config/db");
const { Pack, EvidenceEvent, computeEstimate } = require("../models/models");
const { loadBundledPacks } = require("../packs/loader");
const { normalizeTopic } = require("../packs/topic");
const { certaintyFor } = require("../engine/session");

const API_URL = (process.argv[2] || process.env.API_URL || "http://127.0.0.1:3000").replace(/\/+$/, "");
const topic = process.argv[3] || process.env.DEMO_TOPIC || "Binary search";
const outputDir = path.join(os.homedir(), ".cache", "tmp", "opencode", "clario-learners");
const QUALITY_NAMES = ["code_keyed", "llm_keyed", "llm_graded"];

async function api(method, route, body) {
  const response = await fetch(`${API_URL}${route}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let value;
  try {
    value = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${method} ${route}: API returned non-JSON (${response.status})`);
  }
  if (!response.ok) {
    throw new Error(`${method} ${route}: API returned ${response.status}: ${value?.message || text}`);
  }
  return value;
}

async function findPack() {
  const normalized = normalizeTopic(topic);
  const topicKey = normalized.toLowerCase();
  const curated = loadBundledPacks().packs.find((entry) => entry.topic.trim().toLowerCase() === topicKey);
  if (curated) return curated;

  const stored = await Pack.findOne({ topicKey }).lean();
  if (!stored?.pack) {
    throw new Error(`No cached pack for ${topic}. The demo will not generate one.`);
  }
  return stored.pack;
}

function privateQuestion(pack, section, questionId) {
  const question = pack[section].find((entry) => entry.id === questionId);
  if (!question) throw new Error(`API returned unknown ${section} question ${questionId}`);
  return question;
}

function answerFor(question, correct) {
  const key = question.answerKey;
  if (correct) {
    if (key?.type === "option") return key.value;
    if (key?.type === "tokens") return key.value.join(" ");
    if (!key && question.rubric) return question.rubric;
    throw new Error(`Cannot simulate a known correct response for question ${question.id}`);
  }

  if (question.kind === "mcq" || key?.type === "option") return "__intentionally_wrong__";
  if (key?.type === "tokens") return "__intentionally_wrong__";
  return "I don't know.";
}

async function getQuestionEvents(sessionId, questionId) {
  return EvidenceEvent.find({ sessionId, questionId }).lean();
}

async function runProfile(profile, pack) {
  const created = await api("POST", "/session", { topic, goal: "demo" });
  const sessionId = created.sessionId;
  let diagnosticQuestion = created.firstQuestion;
  let diagnosisDone = created.done;
  const diagnostic = [];

  while (diagnosticQuestion && !diagnosisDone) {
    const question = privateQuestion(pack, "diagnostic", diagnosticQuestion.id);
    let skip = false;
    let correct = false;

    if (profile === "beginner") {
      skip = true;
    } else if (profile === "strong") {
      correct = true;
    } else {
      // The engine selects at least one question at each tier. The partial learner gets the
      // easy and middle tiers right and the hard tier wrong.
      correct = question.difficulty < 3;
    }

    const result = await api("POST", "/diagnose", {
      sessionId,
      questionId: diagnosticQuestion.id,
      ...(skip ? { skip: true } : { answer: answerFor(question, correct) }),
    });
    const events = skip ? [] : await getQuestionEvents(sessionId, question.id);
    const observed = skip
      ? "skipped"
      : events.length && events.every((event) => event.outcome === "correct")
        ? "correct"
        : events.length
          ? events.map((event) => event.outcome).join(",")
          : "no evidence";
    if (!skip && !events.length) {
      throw new Error(`${profile} diagnostic ${question.id} produced no evidence; cannot verify the intended answer.`);
    }
    if (!skip && correct && events.length && events.some((event) => event.outcome !== "correct")) {
      throw new Error(`${profile} expected diagnostic ${question.id} correct, but evidence was not all correct.`);
    }
    if (!skip && !correct && events.length && events.every((event) => event.outcome === "correct")) {
      throw new Error(`${profile} expected diagnostic ${question.id} wrong, but all evidence was correct.`);
    }
    diagnostic.push({
      questionId: question.id,
      difficulty: question.difficulty,
      requested: skip ? "skip" : correct ? "correct" : "incorrect",
      observed,
      evidenceCount: events.length,
      done: result.done,
    });
    diagnosticQuestion = result.nextQuestion;
    diagnosisDone = result.done;
  }

  const checks = [];
  const maxChecks = profile === "beginner" ? 1 : 2;
  let nextCheck = (await api("POST", "/check", { sessionId })).nextQuestion;
  while (nextCheck && checks.length < maxChecks) {
    const question = privateQuestion(pack, "check", nextCheck.id);
    const correct = profile === "strong" || (profile === "partial" && checks.length === 0);
    const result = await api("POST", "/check", {
      sessionId,
      questionId: question.id,
      answer: answerFor(question, correct),
    });
    checks.push({
      questionId: question.id,
      difficulty: question.difficulty,
      requested: correct ? "correct" : "incorrect",
      observed: result.correct ? "correct" : "incorrect",
      checkComplete: result.checkComplete,
    });
    nextCheck = result.nextQuestion;
  }

  if (profile === "beginner" && checks.length !== 1) {
    throw new Error("Beginner profile expected a first check question.");
  }
  if (profile !== "beginner" && checks.length !== 2) {
    throw new Error(`${profile} profile expected two check questions, received ${checks.length}.`);
  }
  if (profile === "strong" && checks.some((entry) => entry.observed !== "correct")) {
    throw new Error("Strong profile did not get both check questions right.");
  }
  if (profile === "partial" && (checks[0].observed !== "correct" || checks[1].observed !== "incorrect")) {
    throw new Error("Partial profile did not get one check right followed by one wrong.");
  }
  if (profile === "beginner" && checks[0].observed !== "incorrect") {
    throw new Error("Beginner profile did not fail the first check question.");
  }

  const plan = await api("GET", `/plan/${encodeURIComponent(sessionId)}`);
  const events = await EvidenceEvent.find({ sessionId }).lean();
  const estimates = computeEstimate(events, pack.concepts, pack.status);
  const estimateById = new Map(estimates.map((entry) => [entry.conceptId, entry]));
  const findingsMatchEngine = plan.findings.every((finding) => {
    const estimate = estimateById.get(finding.conceptId);
    return estimate && finding.status === estimate.status && finding.certainty === certaintyFor(pack.status, estimate);
  });

  const qualityByConcept = {};
  for (const concept of pack.concepts) {
    const related = events.filter((event) => String(event.conceptId) === concept.id);
    qualityByConcept[concept.id] = Object.fromEntries([
      ...QUALITY_NAMES.map((quality) => [quality, related.filter((event) => event.evidenceQuality === quality).length]),
      ["unrated", related.filter((event) => !event.evidenceQuality).length],
    ]);
  }

  const stepIds = plan.steps.map((step) => step.conceptId);
  const orderedIds = [...stepIds, ...plan.findings.map((finding) => finding.conceptId).filter((id) => !stepIds.includes(id))];
  const orderedFindings = orderedIds.map((id) => plan.findings.find((finding) => finding.conceptId === id));
  const raw = {
    profile,
    session: created,
    diagnostic,
    checks,
    plan,
    evidenceQualityCounts: qualityByConcept,
    invariantCheck: { findingsMatchEngine, allPlanStatusesFromEngine: findingsMatchEngine },
  };

  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(path.join(outputDir, `${profile}.json`), `${JSON.stringify(raw, null, 2)}\n`);

  console.log(`\n${profile.toUpperCase()} — ${topic}`);
  console.log("Plan concepts (step order, then remaining findings):");
  for (const finding of orderedFindings) {
    const counts = qualityByConcept[finding.conceptId];
    const qualityCount = QUALITY_NAMES.reduce((sum, key) => sum + counts[key], 0);
    const weakest = estimateById.get(finding.conceptId)?.evidenceQuality || "none";
    console.log(
      `  ${finding.title}: status=${finding.status}, certainty=${finding.certainty || "none"}, evidence-quality count=${qualityCount} (${QUALITY_NAMES.map((key) => `${key}=${counts[key]}`).join(", ")}; weakest=${weakest})`
    );
  }
  console.log(`  checks: ${checks.map((entry) => entry.observed).join(" then ")}`);
  console.log(`  invariant check: ${findingsMatchEngine ? "pass" : "FAIL"}`);
  console.log(`  raw JSON: ${path.join(outputDir, `${profile}.json`)}`);

  return { profile, plan, diagnostic, checks, findingsMatchEngine };
}

async function main() {
  await db.connect();
  try {
    const pack = await findPack();
    const results = [];
    for (const profile of ["beginner", "partial", "strong"]) {
      results.push(await runProfile(profile, pack));
    }

    console.log("\nHOW THEY DIFFER");
    for (const result of results) {
      const order = result.plan.steps.map((step) => step.title).join(" → ") || "no steps";
      const statuses = result.plan.findings.reduce((counts, finding) => {
        counts[finding.status] = (counts[finding.status] || 0) + 1;
        return counts;
      }, {});
      console.log(`  ${result.profile}: ${order}; findings=${JSON.stringify(statuses)}`);
    }
    if (results.some((result) => !result.findingsMatchEngine)) {
      throw new Error("A plan status or certainty differs from the deterministic engine estimate.");
    }
  } finally {
    await db.disconnect();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
