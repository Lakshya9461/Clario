// The plan: what the recorded evidence says, and which concepts to work through, in order.
//
// The order and the membership come from the server, decided in code from the prerequisite graph.
// The model only wrote the wording, so this screen never re-sorts anything. A finding marked
// "likely demonstrated" is generated evidence and says so; "not assessed yet" is not a weakness.

import { api } from "../api.js";
import Notice from "../components/Notice.jsx";
import { Busy, Failure } from "../components/Status.jsx";
import { CONFIDENCE_LABEL, statusLabel } from "../labels.js";
import { useLoad } from "../useLoad.js";

export default function Plan({ session, onStudy, onCheck }) {
  const { status, data, error, retry } = useLoad(`plan:${session.sessionId}`, () =>
    api.plan(session.sessionId)
  );

  if (status === "loading") return <Busy label="Reading your answers against the topic…" />;
  if (status === "error") return <Failure error={error} onRetry={retry} />;

  const assessed = data.findings.filter((finding) => finding.status !== "unknown");
  const unassessed = data.findings.length - assessed.length;

  return (
    <section className="screen">
      <p className="screen__eyebrow">Your plan</p>
      <h2 className="plan__objective">{data.objective}</h2>

      {data.degraded ? (
        <Notice tone="info">
          The assistant could not be reached, so this plan is worded by Clario itself. The steps
          are the same either way.
        </Notice>
      ) : null}

      {data.steps.length === 0 ? (
        <Notice tone="info">
          Nothing is left to study: every concept already has enough evidence behind it.
        </Notice>
      ) : (
        <ol className="steps">
          {data.steps.map((step, index) => (
            <li key={step.conceptId} className="step">
              <div className="step__body">
                <h3 className="step__title">{step.title}</h3>
                <p className="step__description">{step.description}</p>
                <p className="step__reason">{step.reason}</p>
              </div>
              <button
                type="button"
                className="button"
                onClick={() => onStudy(index)}
                // The step is addressed by position, so the label must name the step it opens.
                aria-label={`Study ${step.title}`}
              >
                Study this
              </button>
            </li>
          ))}
        </ol>
      )}

      <details className="findings">
        <summary>
          What the evidence says
          {assessed.length ? ` (${assessed.length} assessed)` : ""}
        </summary>
        {assessed.length === 0 ? (
          <p className="screen__hint">Nothing recorded yet.</p>
        ) : (
          <ul className="findings__list">
            {assessed.map((finding) => (
              <li key={finding.conceptId}>
                <span className="findings__status">{statusLabel(finding)}</span>
                <span className="findings__name">{finding.title}</span>
                <span className="findings__confidence">
                  {CONFIDENCE_LABEL[finding.confidence] ?? finding.confidence}
                </span>
                <span className="findings__why">{finding.why}</span>
              </li>
            ))}
          </ul>
        )}
        {unassessed > 0 ? (
          <p className="screen__hint">
            {unassessed} concept{unassessed === 1 ? "" : "s"} not assessed yet — nothing is known
            about {unassessed === 1 ? "it" : "them"} either way.
          </p>
        ) : null}
      </details>

      <div className="screen__actions">
        <button type="button" className="button button--primary" onClick={onCheck}>
          Take the check
        </button>
      </div>
    </section>
  );
}
