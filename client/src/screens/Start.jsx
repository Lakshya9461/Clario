// Where a session starts: a topic, and why the student is studying it.
//
// The topic is sent as text and nothing else. Pasted source text is deliberately absent: this
// build only serves packs that were prepared ahead of time, and the server refuses a paste with
// source_text_not_supported rather than quietly answering from general knowledge.

import { useState } from "react";
import { api } from "../api.js";
import Notice from "../components/Notice.jsx";
import { GOALS } from "../labels.js";

export default function Start({ onStarted }) {
  const [topic, setTopic] = useState("");
  const [goal, setGoal] = useState("exam");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(event) {
    event.preventDefault();
    if (!topic.trim()) {
      setError(new Error("Type a topic first."));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onStarted(await api.startSession({ topic: topic.trim(), goal }));
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="start">
      <h1 className="start__title">Clario</h1>
      <p className="start__lede">
        Adaptive practice for any topic. Answer a few questions, get a plan built from what you
        actually showed, then check yourself.
      </p>

      <form className="start__form" onSubmit={submit}>
        <label className="field">
          <span className="field__label">What are you studying?</span>
          <input
            type="text"
            value={topic}
            onChange={(event) => setTopic(event.target.value)}
            placeholder="a topic"
            maxLength={120}
            autoFocus
            disabled={busy}
          />
        </label>

        <label className="field">
          <span className="field__label">Studying for</span>
          <select value={goal} onChange={(event) => setGoal(event.target.value)} disabled={busy}>
            {GOALS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        {error ? <Notice tone="error">{error.message}</Notice> : null}

        <button type="submit" className="button button--primary" disabled={busy}>
          {busy ? "Starting…" : "Start studying"}
        </button>
      </form>

      <p className="start__note">
        This beta serves topics that have already been prepared. If a topic is not available yet,
        the server says so instead of inventing it.
      </p>
    </main>
  );
}
