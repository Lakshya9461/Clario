// Read-only inspection of the generated packs stored in Mongo.
// Writes full pack JSON to /tmp/clario-packs-dump.json and prints a compact
// structural report to stdout. Does not mutate anything.
//
// usage: node scripts/dump-packs.js ["topic" ...]   (no topics prints the inventory only)
const fs = require("node:fs");
require("dotenv").config();

const db = require("../config/db");
const { Pack } = require("../models/models");
const { validatePack } = require("../packs/loader");
const { normalizeTopic } = require("../packs/generate");

const WANTED = process.argv.slice(2);

function cycleErrors(concepts) {
  const byId = new Map(concepts.map((c) => [c.id, c]));
  const state = new Map();
  const errors = [];
  function visit(id, trail) {
    if (state.get(id) === "done") return;
    if (state.get(id) === "visiting") {
      errors.push(`prerequisite cycle: ${[...trail.slice(trail.indexOf(id)), id].join(" -> ")}`);
      return;
    }
    const concept = byId.get(id);
    if (!concept) return;
    state.set(id, "visiting");
    for (const prerequisite of concept.prerequisites) visit(prerequisite, [...trail, id]);
    state.set(id, "done");
  }
  for (const concept of concepts) visit(concept.id, []);
  return errors;
}

function report(pack) {
  const conceptIds = new Set(pack.concepts.map((c) => c.id));
  const problems = [];
  const cycles = cycleErrors(pack.concepts);
  if (cycles.length) problems.push(...cycles);

  for (const section of ["diagnostic", "check"]) {
    for (const q of pack[section]) {
      for (const cid of q.conceptIds) {
        if (!conceptIds.has(cid)) problems.push(`${section}/${q.id}: unknown conceptId ${cid}`);
      }
      if (q.kind === "mcq") {
        if (!q.options || q.options.length !== 4) problems.push(`${section}/${q.id}: bad option count`);
        if (q.answerKey?.type !== "option") problems.push(`${section}/${q.id}: key not type option`);
        else if (!q.options.includes(q.answerKey.value)) problems.push(`${section}/${q.id}: key value not among options`);
      }
    }
  }

  const validation = validatePack(pack);

  console.log(`\n================ ${JSON.stringify(pack.topic)}  (packId ${pack.packId})`);
  console.log(`status ${pack.status}  version ${pack.version}  concepts ${pack.concepts.length}  diagnostic ${pack.diagnostic.length}  check ${pack.check.length}`);
  console.log(`validatePack: valid=${validation.valid}`);
  if (validation.errors.length) console.log(`  validator errors: ${validation.errors.join("; ")}`);
  console.log(`cycle check: ${cycles.length ? "FAIL " + cycles.join("; ") : "OK (DAG)"}`);
  console.log(`concept/key check: ${problems.filter((p) => !cycles.includes(p)).length ? problems.filter((p) => !cycles.includes(p)).join("; ") : "OK"}`);

  for (const concept of pack.concepts) {
    const pre = concept.prerequisites.length ? `  <- ${concept.prerequisites.join(", ")}` : "";
    console.log(`  - ${concept.id}${pre}  ${concept.name}: ${concept.description}`);
  }

  for (const section of ["diagnostic", "check"]) {
    for (const q of pack[section]) {
      const keyIndex = q.options ? q.options.indexOf(q.answerKey?.value) : -1;
      console.log(`    [${q.id}] ${q.kind} d${q.difficulty} ${q.transfer ? "transfer" : ""} ${q.requiresWhy ? "why" : ""}`);
      console.log(`      ${q.prompt}`);
      if (q.options) q.options.forEach((o, i) => console.log(`        ${i}. ${o}${i === keyIndex ? "  <-- KEY" : ""}`));
      console.log(`      conceptIds: ${q.conceptIds.join(", ")}`);
    }
  }
}

async function main() {
  await db.connect();
  const all = (await Pack.find({}, { _id: 0 }).lean()).map((doc) => doc.pack);
  await db.disconnect();

  const out = { dumpedAt: new Date().toISOString(), count: all.length, packs: all };
  fs.writeFileSync("/tmp/clario-packs-dump.json", JSON.stringify(out, null, 1));
  console.log(`wrote full dump to /tmp/clario-packs-dump.json (${all.length} packs)`);

  for (const topic of WANTED) {
    const key = normalizeTopic(topic).toLowerCase();
    const pack = all.find((p) => p.topic.trim().toLowerCase() === key);
    if (!pack) {
      console.log(`\n================ ${JSON.stringify(topic)}: NOT STORED`);
      continue;
    }
    report(pack);
  }

  const wantedTopics = WANTED.map((t) => t.trim().toLowerCase());
  const others = all.filter((p) => !wantedTopics.includes(p.topic.trim().toLowerCase()));
  if (others.length) {
    console.log(`\n-- other stored packs: ${others.map((p) => p.topicKey).join(", ")}`);
  }
}

main().catch((e) => {
  console.error("FAILED:", e.message);
  process.exitCode = 1;
});
