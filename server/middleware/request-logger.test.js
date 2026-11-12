const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { requestLogger } = require("./request-logger");

test("request logs contain metadata only and omit request secrets", () => {
  const logs = [];
  const req = {
    method: "POST",
    path: "/answers",
    user: { id: "student-7" },
    headers: { authorization: "Bearer token-secret" },
    body: { password: "password-secret", answer: "student-answer-secret" },
  };
  const res = new EventEmitter();
  res.statusCode = 201;
  let passed = false;

  requestLogger((line) => logs.push(line))(req, res, () => { passed = true; });
  assert.equal(passed, true);
  res.emit("finish");

  assert.equal(logs.length, 1);
  assert.match(logs[0], /^POST \/answers 201 \d+\.\dms user=student-7$/);
  for (const secret of ["token-secret", "password-secret", "student-answer-secret"])
    assert.equal(logs[0].includes(secret), false);
});
