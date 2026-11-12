import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api.js";
import { auth } from "../auth.js";
import Notice from "../components/Notice.jsx";
import { Busy, Failure } from "../components/Status.jsx";
import { sourceLabel } from "../labels.js";

export default function TopicsView() {
  const [topics, setTopics] = useState([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState(null);
  const navigate = useNavigate();

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const data = await api.topics();
        if (active)
          setTopics(Array.isArray(data?.topics) ? data.topics : []);
      } catch (failure) {
        if (active) setError(failure);
      } finally {
        if (active) setBusy(false);
      }
    }
    load();
    return () => {
      active = false;
    };
  }, []);

  async function startSession(topic) {
    setBusy(true);
    setError(null);
    try {
      const session = await auth.startSession({ topic, goal: "exam" });
      navigate(`/learn/${session.sessionId}`, { replace: true });
    } catch (failure) {
      setError(failure.message || "Could not start the session.");
    } finally {
      setBusy(false);
    }
  }

  if (busy) return <Busy label="Loading prepared topics…" />;
  if (error) return <Failure error={error} onRetry={() => window.location.reload()} />;

  return (
    <section className="topics">
      <h1 className="topics__title">Choose a topic</h1>
      <p className="topics__lede">
        Pick a topic that has already been prepared. Each one starts a new
        learning session.
      </p>

      {error ? <Notice tone="error">{error.message}</Notice> : null}

      {topics.length === 0 ? (
        <div className="empty">
          <p className="empty__text">
            No topics are prepared right now. Check back later or contact an
            administrator.
          </p>
        </div>
      ) : (
        <ul className="topics__list">
          {topics.map((entry) => (
            <li key={entry.topic} className="topics__item">
              <button
                type="button"
                className="topic choice"
                onClick={() => startSession(entry.topic)}
                disabled={busy}
              >
                <span className="topic__name">{entry.topic}</span>
                <span className="topic__source">{sourceLabel(entry)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
