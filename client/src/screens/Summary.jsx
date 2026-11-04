// What the session recorded about each concept.
//
// Read-only in the beta. "not assessed yet" is shown as exactly that, never as a weakness: the
// model records evidence, and an absence of evidence is an absence of evidence. A generated pack
// can only ever reach "likely demonstrated", which is the label the server's `certainty` carries.

import { api } from "../api.js";
import Notice from "../components/Notice.jsx";
import { Busy, Failure } from "../components/Status.jsx";
import { CONFIDENCE_LABEL } from "../labels.js";
import { useLoad } from "../useLoad.js";

export default function Summary({ session, onRestart }) {
  const { status, data, error, retry } = useLoad(`model:${session.sessionId}`, () =>
    api.model(session.sessionId)
  );

  if (status === "loading") return <Busy label="Putting your results together…" />;
  if (status === "error") return <Failure error={error} onRetry={retry} />;

  const assessed = data.concepts.filter((concept) => concept.status !== "unknown");

  return (
    <section className="screen">
      <p className="screen__eyebrow">Session summary</p>
      <h2 className="plan__objective">
        {assessed.length
          ? `${assessed.length} of ${data.concepts.length} concepts have evidence behind them.`
          : "No concepts have evidence behind them yet."}
      </h2>

      {data.lowEvidence ? (
        <Notice tone="info">
          Part of the diagnosis was skipped, so treat this as a rough picture rather than a
          measurement.
        </Notice>
      ) : null}

      <ul className="concepts">
        {data.concepts.map((concept) => (
          <li key={concept.id} className={`concept concept--${concept.status}`}>
            <span className="concept__name">{concept.name}</span>
            <span className="concept__status">
              {concept.status === "unknown"
                ? "not assessed yet"
                : (CONFIDENCE_LABEL[concept.confidence] ?? concept.confidence)}
            </span>
            {concept.notes.length ? (
              <ul className="concept__notes">
                {concept.notes.map((note, index) => (
                  <li key={index}>{note}</li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>

      <p className="screen__hint">
        Notes are what was recorded, not a verdict about you: a wrong answer is evidence about one
        question, not about what you understand.
      </p>

      <div className="screen__actions">
        <button type="button" className="button button--primary" onClick={onRestart}>
          Study another topic
        </button>
      </div>
    </section>
  );
}
