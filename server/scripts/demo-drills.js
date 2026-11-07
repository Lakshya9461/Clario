#!/usr/bin/env node
// Demo load check: N learners start at the same moment and answer one question each.
//
// It reads GET /topics and uses the first prepared topic, so it can never name a subject. A 503
// from the model queue is retried once with the same answer: if the claim were not released on a
// failed grading, that retry would be a 409 and the run would report it.
//
// usage: node scripts/demo-drills.js [sessions=3] [base=http://127.0.0.1:3000]
// exit: 0 when every session ended in 201/200, 1 when one did not

const sessions = Math.max(1, Number.parseInt(process.argv[2] || "3", 10) || 3);
const base = String(process.argv[3] || "http://127.0.0.1:3000").replace(/\/+$/, "");

// A demo build should not sit on a stalled socket in front of an audience.
const REQUEST_TIMEOUT_MS = 90_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { "content-type": "application/json", ...(options.headers || {}) },
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    // The status is enough to report an unexpected non-JSON response.
  }
  return { response, body };
}

function answerFor(question) {
  if (Array.isArray(question?.options) && question.options.length) {
    return question.options[0];
  }
  return "I am working through this question.";
}

async function startSession(topic) {
  return request("/session", {
    method: "POST",
    body: JSON.stringify({ topic, goal: "exam" }),
  });
}

async function driveSession(topic, index) {
  const startedAt = Date.now();
  let started;
  try {
    started = await startSession(topic);
    if (started.response.status !== 201) {
      return {
        index,
        started: false,
        status: started.response.status,
        elapsed: Date.now() - startedAt,
        retried: false,
        error: started.body?.error || "start_failed",
      };
    }

    const question = started.body?.firstQuestion;
    if (!question) {
      return {
        index,
        started: true,
        status: 201,
        elapsed: Date.now() - startedAt,
        retried: false,
        error: null,
      };
    }

    const answer = answerFor(question);
    let retried = false;
    let result = await request("/diagnose", {
      method: "POST",
      body: JSON.stringify({
        sessionId: started.body.sessionId,
        questionId: question.id,
        answer,
      }),
    });

    if (result.response.status === 503) {
      retried = true;
      await sleep(2000);
      result = await request("/diagnose", {
        method: "POST",
        body: JSON.stringify({
          sessionId: started.body.sessionId,
          questionId: question.id,
          answer,
        }),
      });
    }

    return {
      index,
      started: true,
      status: result.response.status,
      elapsed: Date.now() - startedAt,
      retried,
      error: result.response.ok ? null : result.body?.error || "diagnose_failed",
    };
  } catch (error) {
    return {
      index,
      started: false,
      status: "error",
      elapsed: Date.now() - startedAt,
      retried: false,
      error: error.message,
    };
  }
}

async function main() {
  const topics = await request("/topics");
  if (!topics.response.ok || !Array.isArray(topics.body?.topics) || !topics.body.topics.length) {
    console.error(`could not read prepared topics (${topics.response.status})`);
    process.exitCode = 1;
    return;
  }

  const topic = topics.body.topics[0].topic;
  const results = await Promise.all(
    Array.from({ length: sessions }, (_, index) => driveSession(topic, index + 1))
  );

  let created = 0;
  let answered = 0;
  let busy = 0;
  let successfulRetry = 0;
  let failed = 0;

  for (const result of results) {
    // A session that started and answered counts in both columns; the summary is about what the
    // server did, not about which status came last.
    if (result.started) created += 1;
    if (result.status === 200) answered += 1;
    if (result.status === 503) busy += 1;
    if (result.retried && result.status === 200) successfulRetry += 1;
    if (!result.started || (result.status !== 201 && result.status !== 200)) failed += 1;
    const retryText = result.retried ? " retried=yes" : " retried=no";
    const errorText = result.error ? ` error=${result.error}` : "";
    console.log(
      `session ${result.index}: status=${result.status} elapsed_ms=${result.elapsed}${retryText}${errorText}`
    );
  }

  console.log(
    `summary: sessions=${sessions} started_201=${created} answered_200=${answered} busy_503=${busy} successful_retry=${successfulRetry} failed=${failed}`
  );
  process.exitCode = failed ? 1 : 0;
}

main().catch((error) => {
  console.error(`drill failed: ${error.message}`);
  process.exitCode = 1;
});
