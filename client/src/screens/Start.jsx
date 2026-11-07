// Where a session starts: a topic, and why the student is studying it.
//
// The topic is sent as text and nothing else. Pasted source text is deliberately absent: this
// build only serves packs that were prepared ahead of time, and the server refuses a paste with
// source_text_not_supported rather than quietly answering from general knowledge.
//
// The list of prepared topics comes from the server so a student does not have to guess a name and
// collect a 404. It is a shortcut, not a requirement: a typed topic still goes through the same
// request, and a list that cannot be fetched simply does not appear.

import { useEffect, useState } from "react";
import { api } from "../api.js";
import Notice from "../components/Notice.jsx";
import { GOALS } from "../labels.js";
import { DATA_NOTICE } from "../privacy.js";

// A generated pack is weaker evidence than a curated one (A4), so the list says which kind each
// entry is instead of showing one unqualified list. `reviewed` is the server's answer to a second,
// separate question: was this assistant-written pack actually read and key-checked before it was
// served, or is it as the model wrote it?
function sourceLabel(entry) {
  if (entry.source === "curated") return "reviewed";
  return entry.reviewed ? "assistant-written, key-checked" : "assistant-written, unreviewed";
}

export default function Start({ onStarted }) {
  const [topic, setTopic] = useState("");
  const [goal, setGoal] = useState("exam");
  const [topics, setTopics] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let active = true;
    api
      .topics()
      .then((data) => {
        if (active) setTopics(Array.isArray(data?.topics) ? data.topics : []);
      })
      .catch(() => {
        // Nothing to say here: the form below still works, and starting a session reports the real
        // failure if the server is down.
      });
    return () => {
      active = false;
    };
  }, []);

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
      <p className="start__badge">
        <span className="tag tag--beta">Beta</span>
      </p>
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

        {topics.length ? (
          <div className="start__topics">
            <p className="start__topics-label" id="prepared-topics">
              Prepared right now
            </p>
            <ul className="start__topics-list" aria-labelledby="prepared-topics">
              {topics.map((entry) => (
                <li key={entry.topic}>
                  <button
                    type="button"
                    className="topic"
                    onClick={() => setTopic(entry.topic)}
                    disabled={busy}
                    aria-pressed={topic === entry.topic}
                  >
                    <span className="topic__name">{entry.topic}</span>
                    <span className="topic__source">{sourceLabel(entry)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

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
        the server says so instead of inventing it. Prepared material can be assistant-written and
        unreviewed, so anything the app says is generated and unverified unless a lesson cites a
        source.
      </p>

      <section className="data-notice" aria-labelledby="data-notice-title">
        <h2 className="data-notice__title" id="data-notice-title">
          What this beta stores
        </h2>
        <p className="data-notice__body">{DATA_NOTICE}</p>
      </section>
    </main>
  );
}
