import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { auth } from "../auth.js";
import Diagnostic from "../screens/Diagnostic.jsx";
import Plan from "../screens/Plan.jsx";
import Lesson from "../screens/Lesson.jsx";
import Check from "../screens/Check.jsx";
import Summary from "../screens/Summary.jsx";
import Notice from "../components/Notice.jsx";

const STAGES = ["diagnose", "plan", "check", "summary"];

export default function LearnView() {
  const { sessionId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [phase, setPhase] = useState("diagnose");
  const [stepIndex, setStepIndex] = useState(0);
  const [session, setSession] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const fromState = location.state?.session;
    const fromStorage = auth.getSession();
    const found = fromState || fromStorage;
    if (found && found.sessionId === sessionId) {
      setSession(found);
    } else if (!found) {
      setError("No session found. Start one from Topics.");
    } else {
      setError("Session does not match. Start one from Topics.");
    }
  }, [sessionId, location.state?.session]);

  if (error) {
    return (
      <section className="learn">
        <Notice tone="error">{error}</Notice>
        <div className="screen__actions">
          <Link to="/topics" className="button button--primary">
            Go to Topics
          </Link>
        </div>
      </section>
    );
  }
  if (!session) return null;

  const stage = STAGES.indexOf(phase === "lesson" ? "plan" : phase);

  function restart() {
    auth.clearSession();
    navigate("/topics", { replace: true });
  }

  return (
    <section className="learn">
      <header className="learn__header">
        <Link to="/topics" className="learn__brand">Clario</Link>
        <span className="tag tag--beta">Beta</span>
        <p className="learn__topic">{session.topic}</p>
        <ol className="progress" aria-label="Progress">
          {STAGES.map((name, index) => (
            <li
              key={name}
              className={`progress__item${index <= stage ? " progress__item--done" : ""}`}
              aria-current={index === stage ? "step" : undefined}
            >
              {name}
            </li>
          ))}
        </ol>
        {session.packStatus === "generated" ? (
          <Notice tone="info">
            This topic was written for you by the assistant and has not been
            reviewed: treat its content as generated and unverified.
          </Notice>
        ) : null}
      </header>

      {phase === "diagnose" ? (
        <Diagnostic
          session={session}
          onDone={() => setPhase("plan")}
        />
      ) : null}

      {phase === "plan" ? (
        <Plan
          session={session}
          onStudy={(index) => {
            setStepIndex(index);
            setPhase("lesson");
          }}
          onCheck={() => setPhase("check")}
        />
      ) : null}

      {phase === "lesson" ? (
        <Lesson
          session={session}
          stepIndex={stepIndex}
          onBack={() => setPhase("plan")}
          onCheck={() => setPhase("check")}
        />
      ) : null}

      {phase === "check" ? (
        <Check session={session} onDone={() => setPhase("summary")} />
      ) : null}

      {phase === "summary" ? (
        <Summary session={session} onRestart={restart} />
      ) : null}

      <footer className="foot">
        <p className="foot__text">
          Beta. Results are saved on this server under a random session id. No
          accounts, no analytics.
        </p>
      </footer>
    </section>
  );
}
