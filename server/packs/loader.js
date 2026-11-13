// Pack loading and validation (A1/A2).
// A pack is the ONLY place topic content lives. Nothing in this file may name a subject,
// a concept, a question or a graph: it only knows the pack shape and its invariants.
//
// validatePack(raw) returns { valid, errors }. It never throws and never mutates the input.
// The pack is returned as authored (unknown keys are kept, not stripped) because curated
// packs carry review notes the engine does not read but humans maintain.

const fs = require("node:fs");
const path = require("node:path");
const { z } = require("zod");
const { topicKey } = require("./topic");

const PACKS_DIR = __dirname;

const conceptSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  prerequisites: z.array(z.string().min(1)),
});

const answerKeySchema = z.union([
  z.object({ type: z.string().min(1), value: z.unknown() }),
  z.null(),
]);

const questionSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["mcq", "predict_output", "free_text"]),
  prompt: z.string().min(1),
  code: z.string().optional(),
  options: z.array(z.string().min(1)).optional(),
  conceptIds: z.array(z.string().min(1)).min(1),
  difficulty: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  transfer: z.boolean(),
  requiresWhy: z.boolean(),
  answerKey: answerKeySchema,
  // Set by a pack on a question that asks the student to rate themselves: it has no key and is
  // recorded as a self-report instead of being graded.
  selfReport: z.boolean().optional(),
  rubric: z.string().optional(),
  fallbackFeedback: z.object({ correct: z.string().min(1), incorrect: z.string().min(1) }),
  optionHints: z.record(z.string(), z.string()).optional(),
});

const traceSchema = z.object({
  code: z.string(),
  steps: z.array(
    z.object({
      stack: z.array(z.string()),
      output: z.array(z.string()),
      note: z.string(),
    })
  ),
  finalOutput: z.array(z.string()).optional(),
});

const sourceSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  url: z.string().min(1),
  license: z.string().min(1),
  text: z.string().min(1),
});

const packSchema = z.object({
  packId: z.string().min(1),
  topic: z.string().min(1),
  status: z.enum(["curated", "generated"]),
  version: z.string().min(1),
  concepts: z.array(conceptSchema).min(1),
  diagnostic: z.array(questionSchema),
  check: z.array(questionSchema),
  traces: z.record(z.string(), traceSchema),
  sources: z.array(sourceSchema),
});

function formatIssue(issue) {
  const where = issue.path.length ? issue.path.join(".") : "(root)";
  return `${where}: ${issue.message}`;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

// Cycle detection over the prerequisite edges. Returns one message per cycle found.
function cycleErrors(concepts) {
  const byId = new Map(concepts.map((c) => [c.id, c]));
  const state = new Map(); // id -> "visiting" | "done"
  const errors = [];

  function visit(id, trail) {
    if (state.get(id) === "done") return;
    if (state.get(id) === "visiting") {
      const cycle = [...trail.slice(trail.indexOf(id)), id].join(" -> ");
      errors.push(`prerequisite cycle: ${cycle}`);
      return;
    }
    const concept = byId.get(id);
    if (!concept) return; // dangling prerequisites are reported separately
    state.set(id, "visiting");
    for (const prerequisite of concept.prerequisites) visit(prerequisite, [...trail, id]);
    state.set(id, "done");
  }

  for (const concept of concepts) visit(concept.id, []);
  return errors;
}

// Invariants that span fields: ids, the prerequisite graph, references, keys.
function crossFieldErrors(pack) {
  const errors = [];

  const conceptIds = new Set();
  for (const [i, concept] of pack.concepts.entries()) {
    if (conceptIds.has(concept.id)) {
      errors.push(`concepts[${i}]: duplicate concept id "${concept.id}"`);
    }
    conceptIds.add(concept.id);
  }

  for (const [i, concept] of pack.concepts.entries()) {
    for (const prerequisite of concept.prerequisites) {
      if (!conceptIds.has(prerequisite)) {
        errors.push(
          `concepts[${i}] "${concept.id}": prerequisite "${prerequisite}" does not exist`
        );
      }
    }
  }
  errors.push(...cycleErrors(pack.concepts));

  const questionIds = new Set();
  for (const section of ["diagnostic", "check"]) {
    for (const [i, question] of pack[section].entries()) {
      const at = `${section}[${i}] "${question.id}"`;
      if (questionIds.has(question.id)) errors.push(`${at}: duplicate question id`);
      questionIds.add(question.id);

      for (const conceptId of question.conceptIds) {
        if (!conceptIds.has(conceptId)) {
          errors.push(`${at}: conceptId "${conceptId}" does not exist`);
        }
      }

      if (pack.status === "generated" && question.kind === "predict_output") {
        errors.push(`${at}: generated packs may only use "mcq" and "free_text"`);
      }

      if (question.kind === "mcq") {
        if (!question.options || !question.options.length) {
          errors.push(`${at}: mcq question has no options`);
        }
        if (question.answerKey && question.answerKey.type !== "option") {
          errors.push(`${at}: mcq answer key must be of type "option"`);
        }
      }

      if (question.answerKey) {
        const { type, value } = question.answerKey;
        if (type === "option") {
          if (!isNonEmptyString(value)) {
            errors.push(`${at}: answer key of type "option" must be a string`);
          } else if (question.options && !question.options.includes(value)) {
            errors.push(`${at}: answer key "${value}" is not one of its options`);
          }
        } else if (type === "tokens") {
          if (!Array.isArray(value) || !value.length || !value.every(isNonEmptyString)) {
            errors.push(`${at}: answer key of type "tokens" must be a non-empty array of strings`);
          }
        } else if (value === null || value === undefined) {
          errors.push(`${at}: answer key of type "${type}" has no value`);
        }
      }

      if (question.traceId !== undefined && !(question.traceId in pack.traces)) {
        errors.push(`${at}: traceId "${question.traceId}" does not exist in traces`);
      }
    }
  }

  const sourceIds = new Set();
  for (const [i, source] of pack.sources.entries()) {
    if (sourceIds.has(source.id)) errors.push(`sources[${i}]: duplicate source id "${source.id}"`);
    sourceIds.add(source.id);
    try {
      new URL(source.url);
    } catch {
      errors.push(`sources[${i}] "${source.id}": url "${source.url}" is not a valid URL`);
    }
  }

  return errors;
}

function validatePack(raw) {
  const parsed = packSchema.safeParse(raw);
  if (!parsed.success) {
    return { valid: false, errors: parsed.error.issues.map(formatIssue) };
  }
  const errors = crossFieldErrors(raw);
  return { valid: errors.length === 0, errors };
}

function loadPackFile(filePath) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    return { file: filePath, pack: null, errors: [`cannot read JSON: ${error.message}`] };
  }
  const { valid, errors } = validatePack(raw);
  return { file: filePath, pack: valid ? raw : null, errors };
}

function listPackFiles(dir = PACKS_DIR) {
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => path.join(dir, name));
}

// Packs that ship with the repository: the .json files committed next to this module. They carry
// their own status, and both are served — a curated pack is one a human wrote, a bundled generated
// pack is one that was reviewed and shipped so a fresh server has something to demo. The status is
// kept as authored, because A4 hangs off it ("likely demonstrated" for generated evidence).
function loadBundledPacks(dir = PACKS_DIR) {
  const packs = [];
  const errors = [];
  for (const file of listPackFiles(dir)) {
    const result = loadPackFile(file);
    if (result.pack) packs.push(result.pack);
    else errors.push({ file, errors: result.errors });
  }
  return { packs, errors };
}

// A3: match the student's topic against a curated pack, case-insensitively.
function findPackByTopic(topic, packs) {
  if (typeof topic !== "string") return null;
  // Same key the store uses: runs of whitespace are not distinct topics.
  const wanted = topicKey(topic);
  if (!wanted) return null;
  return packs.find((pack) => topicKey(pack.topic) === wanted) || null;
}

module.exports = {
  PACKS_DIR,
  validatePack,
  loadPackFile,
  loadBundledPacks,
  findPackByTopic,
};
