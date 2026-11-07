// The check: three questions at rising difficulty, one of them in a new context and one asking for
// a short explanation.
//
// The first question comes from the fetch mode of POST /check (no questionId) — the only way a
// client is given one — and later ones come back with each answer. `correct` is the server's
// verdict: a keyed answer is decided in code, so this screen never re-grades anything.

import { useState } from "react";
import { api } from "../api.js";
import Question from "../components/Question.jsx";
import Notice from "../components/Notice.jsx";
import { Busy, Failure } from "../components/Status.jsx";
import { forgetLoaded, useLoad } from "../useLoad.js";

export default function Check({ session, onDone }) {
  const first = useLoad(`check:${session.sessionId}`, () =>
    api.nextCheckQuestion(session.sessionId)
  );

  // The question being answered comes from the first fetch until an answer replaces it.
  const [question, setQuestion] = useState(null);
  const [answered, setAnswered] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const current = question ?? first.data?.nextQuestion ?? null;

  async function submit(answer, why) {
    setBusy(true);
    setError(null);
    try {
      const data = await api.check({
        sessionId: session.sessionId,
        questionId: current.id,
        answer,
        why: why || null,
      });
      // Evidence changed, so a cached plan or model would now be out of date.
      forgetLoaded();
      setAnswered((count) => count + 1);
      setResult(data);
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }

  function advance() {
    const following = result?.nextQuestion ?? null;
    const complete = result?.checkComplete === true;
    setResult(null);
    if (complete || !following) {
      onDone();
      return;
    }
    setQuestion(following);
  }

  if (first.status === "loading") return <Busy label="Picking your check question…" />;
  if (first.status === "error") return <Failure error={first.error} onRetry={first.retry} />;

  if (!current) {
    return (
      <section className="screen">
        <p className="screen__eyebrow">Check</p>
        <Notice tone="info">You have already answered a question at every difficulty.</Notice>
        <div className="screen__actions">
          <button type="button" className="button button--primary" onClick={onDone}>
            See how you did
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="screen">
      <p className="screen__eyebrow">
        Check
        <span aria-hidden="true"> · </span>
        {answered === 0 ? "first question" : `${answered} answered`}
      </p>

      {error ? <Notice tone="error">{error.message}</Notice> : null}

      {result ? (
        <div className="result">
          <p className={`result__verdict ${result.correct === true ? "result__verdict--right" : ""}`}>
            {result.selfReport ? "Your own rating" : result.correct === true ? "Correct" : "Not this time"}
          </p>
          {result.feedback ? <p className="result__feedback">{result.feedback}</p> : null}
          {result.degraded ? (
            <Notice tone="info">
              The assistant could not be reached, so this feedback is the topic pack's own wording.
            </Notice>
          ) : null}
          <button type="button" className="button button--primary" onClick={advance}>
            {result.checkComplete ? "See how you did" : "Next question"}
          </button>
        </div>
      ) : (
        <Question key={current.id} question={current} busy={busy} onAnswer={submit} />
      )}
    </section>
  );
}
