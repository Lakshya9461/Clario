// One question, of any of the three kinds the contract allows.
//
// The answer key never reaches the browser, so this cannot mark anything itself: it collects an
// answer (and an explanation when the question asks for one) and hands it to the server. The
// component is keyed by question id by its caller, so its own state starts clean on each question.

import { useState } from "react";
import { kindLabel } from "../labels.js";

export default function Question({ question, busy = false, allowSkip = false, onAnswer, onSkip }) {
  const [chosen, setChosen] = useState(null);
  const [written, setWritten] = useState("");
  const [why, setWhy] = useState("");

  const isChoice = Array.isArray(question.options) && question.options.length > 0;
  const ready = isChoice ? chosen !== null : written.trim().length > 0;

  function submit(event) {
    event.preventDefault();
    if (!ready || busy) return;
    onAnswer(isChoice ? question.options[chosen] : written.trim(), why.trim());
  }

  return (
    <form className="question" onSubmit={submit}>
      <p className="question__meta">
        {kindLabel(question)}
        <span aria-hidden="true"> · </span>
        difficulty {question.difficulty} of 3
        {question.transfer ? (
          <>
            <span aria-hidden="true"> · </span>
            <span className="tag">new context</span>
          </>
        ) : null}
      </p>

      <h2 className="question__prompt">{question.prompt}</h2>
      {question.code ? <pre className="code">{question.code}</pre> : null}

      {isChoice ? (
        <fieldset className="options">
          <legend className="visually-hidden">Choose one option</legend>
          {question.options.map((option, index) => (
            <label
              key={`${question.id}-${index}`}
              className={`option${chosen === index ? " option--chosen" : ""}`}
            >
              <input
                type="radio"
                name={`answer-${question.id}`}
                checked={chosen === index}
                onChange={() => setChosen(index)}
                disabled={busy}
              />
              <span>{option}</span>
            </label>
          ))}
        </fieldset>
      ) : (
        <label className="field">
          <span className="field__label">Your answer</span>
          <textarea
            value={written}
            onChange={(event) => setWritten(event.target.value)}
            rows={4}
            disabled={busy}
            placeholder="Answer in your own words."
          />
        </label>
      )}

      {question.requiresWhy ? (
        <label className="field">
          <span className="field__label">Why? (a sentence is enough)</span>
          <textarea
            value={why}
            onChange={(event) => setWhy(event.target.value)}
            rows={2}
            disabled={busy}
            placeholder="What makes that the answer?"
          />
        </label>
      ) : null}

      <div className="question__actions">
        <button type="submit" className="button button--primary" disabled={!ready || busy}>
          {busy ? "Sending…" : "Submit answer"}
        </button>
        {allowSkip ? (
          <button type="button" className="button button--quiet" onClick={onSkip} disabled={busy}>
            Skip this one
          </button>
        ) : null}
      </div>
    </form>
  );
}
