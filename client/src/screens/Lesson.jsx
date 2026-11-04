// One lesson for one plan step.
//
// The text may carry a notice the server added in code: a pack with no supplied sources gets
// "General explanation: … generated and unverified" prepended, and that line arrives as a "> "
// blockquote. Citations are the pack's own sources, already filtered server-side, so they are
// rendered as links without further checking here.

import { api } from "../api.js";
import Notice from "../components/Notice.jsx";
import { Busy, Failure } from "../components/Status.jsx";
import LessonText from "../components/LessonText.jsx";
import { useLoad } from "../useLoad.js";

function Trace({ trace }) {
  return (
    <section className="trace">
      <h3 className="section__title">Step through it</h3>
      <pre className="code">{trace.code}</pre>
      <table className="trace__table">
        <thead>
          <tr>
            <th scope="col">Stack</th>
            <th scope="col">Output</th>
            <th scope="col">Note</th>
          </tr>
        </thead>
        <tbody>
          {trace.steps.map((step, index) => (
            <tr key={index}>
              <td>
                <code>{step.stack.join(" | ")}</code>
              </td>
              <td>
                <code>{step.output.join(" ") || "—"}</code>
              </td>
              <td>{step.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export default function Lesson({ session, stepIndex, onBack, onCheck }) {
  const { status, data, error, retry } = useLoad(
    `lesson:${session.sessionId}:${stepIndex}`,
    () => api.lesson({ sessionId: session.sessionId, stepIndex })
  );

  if (status === "loading") return <Busy label="Writing the lesson…" />;
  if (status === "error") return <Failure error={error} onRetry={retry} />;

  return (
    <section className="screen">
      <p className="screen__eyebrow">Lesson · step {stepIndex + 1}</p>

      {data.degraded ? (
        <Notice tone="info">
          The assistant could not be reached, so this is the topic pack's own description of the
          concept.
        </Notice>
      ) : null}

      <LessonText markdown={data.markdown} />

      {data.workedExample ? (
        <section>
          <h3 className="section__title">Worked example</h3>
          <p className="worked-example">{data.workedExample}</p>
        </section>
      ) : null}

      {data.trace ? <Trace trace={data.trace} /> : null}

      {data.citations.length ? (
        <section>
          <h3 className="section__title">Sources</h3>
          <ol className="citations">
            {data.citations.map((citation) => (
              <li key={citation.sourceId}>
                <a href={citation.url} target="_blank" rel="noreferrer">
                  {citation.title}
                </a>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      <div className="screen__actions">
        <button type="button" className="button" onClick={onBack}>
          Back to the plan
        </button>
        <button type="button" className="button button--primary" onClick={onCheck}>
          Take the check
        </button>
      </div>
    </section>
  );
}
