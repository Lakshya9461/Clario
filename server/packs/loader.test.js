// Unit tests for the pack validator. Run with: npm test  (node --test)
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { validatePack, loadBundledPacks, findPackByTopic } = require("./loader");

function concept(id, prerequisites = []) {
  return { id, name: id, description: `Description of ${id}`, prerequisites };
}

function mcq(id, conceptIds, { options = ["first", "second"], answer = "first" } = {}) {
  return {
    id,
    kind: "mcq",
    prompt: `Question ${id}?`,
    options,
    conceptIds,
    difficulty: 1,
    transfer: false,
    requiresWhy: false,
    answerKey: { type: "option", value: answer },
    fallbackFeedback: { correct: "Yes.", incorrect: "Not quite." },
  };
}

function validPack() {
  return {
    packId: "test-pack",
    topic: "test-topic",
    status: "curated",
    version: "0.0.0",
    concepts: [concept("c1"), concept("c2", ["c1"])],
    diagnostic: [mcq("d1", ["c1"])],
    check: [
      mcq("c1r", ["c2"]),
      {
        id: "c2r",
        kind: "predict_output",
        prompt: "What is printed?",
        code: "print(1)",
        conceptIds: ["c2"],
        difficulty: 3,
        transfer: true,
        requiresWhy: false,
        answerKey: { type: "tokens", value: ["1"] },
        fallbackFeedback: { correct: "Yes.", incorrect: "Not quite." },
        traceId: "t1",
      },
    ],
    traces: {
      t1: { code: "print(1)", steps: [{ stack: [], output: ["1"], note: "print" }] },
    },
    sources: [
      { id: "s1", title: "A source", url: "https://example.org/a", license: "CC BY 4.0", text: "Text." },
    ],
  };
}

function errorsOf(mutate) {
  const pack = validPack();
  mutate(pack);
  const { valid, errors } = validatePack(pack);
  assert.equal(valid, false, "expected the pack to be rejected");
  return errors;
}

test("accepts a valid pack", () => {
  const result = validatePack(validPack());
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
});

test("rejects a duplicate concept id", () => {
  const errors = errorsOf((pack) => pack.concepts.push(concept("c1")));
  assert.ok(errors.some((e) => e.includes('duplicate concept id "c1"')), errors.join("; "));
});

test("rejects a prerequisite that does not exist", () => {
  const errors = errorsOf((pack) => pack.concepts[0].prerequisites.push("nope"));
  assert.ok(errors.some((e) => e.includes('prerequisite "nope" does not exist')), errors.join("; "));
});

test("rejects a prerequisite cycle", () => {
  const errors = errorsOf((pack) => {
    pack.concepts[0].prerequisites.push("c2");
  });
  assert.ok(errors.some((e) => e.includes("prerequisite cycle")), errors.join("; "));
});

test("rejects a self-referencing prerequisite", () => {
  const errors = errorsOf((pack) => pack.concepts[0].prerequisites.push("c1"));
  assert.ok(errors.some((e) => e.includes("prerequisite cycle")), errors.join("; "));
});

test("rejects a question about a concept that does not exist", () => {
  const errors = errorsOf((pack) => {
    pack.check[0].conceptIds = ["c9"];
  });
  assert.ok(errors.some((e) => e.includes('conceptId "c9" does not exist')), errors.join("; "));
});

test("rejects an mcq answer key that is not one of its options", () => {
  const errors = errorsOf((pack) => {
    pack.diagnostic[0].answerKey.value = "third";
  });
  assert.ok(errors.some((e) => e.includes('"third" is not one of its options')), errors.join("; "));
});

test("rejects a duplicate question id across diagnostic and check", () => {
  const errors = errorsOf((pack) => {
    pack.check[0].id = "d1";
  });
  assert.ok(errors.some((e) => e.includes('check[0] "d1": duplicate question id')), errors.join("; "));
});

test("rejects a traceId that is not in traces", () => {
  const errors = errorsOf((pack) => {
    pack.check[1].traceId = "t9";
  });
  assert.ok(errors.some((e) => e.includes('traceId "t9" does not exist')), errors.join("; "));
});

test("rejects a missing required field", () => {
  const errors = errorsOf((pack) => {
    delete pack.status;
  });
  assert.ok(errors.some((e) => e.startsWith("status:")), errors.join("; "));
});

test("rejects predict_output in a generated pack", () => {
  const errors = errorsOf((pack) => {
    pack.status = "generated";
  });
  assert.ok(errors.some((e) => e.includes('may only use "mcq" and "free_text"')), errors.join("; "));
});

test("validates every bundled pack", () => {
  const { packs, errors } = loadBundledPacks();
  assert.deepEqual(errors, []);
  assert.ok(packs.some((pack) => pack.status === "curated"), "the curated pack still ships");
});

test("a bundled generated pack is served with its own status", () => {
  // A reviewed generated pack can be committed so a fresh server has something to demo. Its status
  // is what A4 reads, so it must survive the trip through the file.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clario-packs-"));
  const pack = validPack();
  pack.status = "generated";
  // A generated pack may only use mcq and free_text, so drop the traced predict_output question.
  pack.check = [pack.check[0]];
  fs.writeFileSync(path.join(dir, "demo.json"), JSON.stringify(pack));

  const { packs, errors } = loadBundledPacks(dir);
  assert.deepEqual(errors, []);
  assert.equal(packs.length, 1);
  assert.equal(packs[0].status, "generated");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("finds a curated pack by topic, case-insensitively", () => {
  const { packs } = loadBundledPacks();
  const pack = packs[0];
  assert.equal(findPackByTopic(pack.topic.toUpperCase(), packs), pack);
  assert.equal(findPackByTopic(`  ${pack.topic}  `, packs), pack);
  assert.equal(findPackByTopic("no such topic", packs), null);
});

test("topics with runs of whitespace resolve like their single-space form", () => {
  const pack = { ...loadBundledPacks().packs[0], topic: "Photosynthesis  Basics" };
  const packs = [pack];
  // Any mix of tabs, newlines and repeated spaces, in either the query or the pack's own topic.
  assert.equal(findPackByTopic("Photosynthesis Basics", packs), pack);
  assert.equal(findPackByTopic("photosynthesis\tbasics", packs), pack);
  assert.equal(findPackByTopic("  Photosynthesis\n Basics  ", packs), pack);
  assert.equal(findPackByTopic("Photosynthesis     Basics", packs), pack);
  // A pack stored with irregular whitespace is found by the clean spelling.
  const irregular = { ...loadBundledPacks().packs[0], topic: "Binary\t\t  Search" };
  assert.equal(findPackByTopic("Binary Search", [irregular]), irregular);
  assert.equal(findPackByTopic("binary   search", [irregular]), irregular);
});
