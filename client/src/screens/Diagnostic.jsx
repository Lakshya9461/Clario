// The diagnostic: three to five questions, one difficulty at a time, until the server says the
// picture is good enough. A skip is allowed and records no evidence, so the plan that follows says
// it is based on little.
//
// There is no feedback here on purpose: this part is measurement, and marking answers while the
// picture is still being taken would mix teaching into it.

import { useState } from "react";
import { api } from "../api.js";
import Question from "../components/Question.jsx";
import Notice from "../components/Notice.jsx";

export default function Diagnostic({ session, onDone }) {
  const [question, setQuestion] = useState(session.firstQuestion);
  const [asked, setAsked] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [skipped, setSkipped] = useState(false);

  async function submit({ answer = null, skip = false }) {
    setBusy(true);
    setError(null);
    try {
      const data = await api.diagnose({
        sessionId: session.sessionId,
        questionId: question.id,
        answer,
        skip,
      });
      const low = skipped || data.lowEvidence === true;
      setSkipped(low);
      setAsked((count) => count + 1);
      if (data.done || !data.nextQuestion) onDone(low);
      else setQuestion(data.nextQuestion);
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="screen">
      <p className="screen__eyebrow">
        Diagnosis
        <span aria-hidden="true"> · </span>
        {asked === 0 ? "first question" : `${asked} answered`}
      </p>

      {error ? <Notice tone="error">{error.message}</Notice> : null}

      <Question
        key={question.id}
        question={question}
        busy={busy}
        allowSkip={!busy}
        onAnswer={(answer) => submit({ answer })}
        onSkip={() => submit({ skip: true })}
      />

      <p className="screen__hint">
        Three to five questions, spread across difficulties. Skipping is fine — it just means the
        plan will have less to go on.
      </p>
    </section>
  );
}
