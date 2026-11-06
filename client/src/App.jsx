// The flow, and nothing else: one session object, one phase, and the step index the plan handed
// over. Each screen owns its own fetching and its own busy and error state, because each calls a
// different endpoint; this file only decides what is on screen next.
//
// start → diagnose → plan → (lesson | check) → summary → start

import { useState } from "react";
import Start from "./screens/Start.jsx";
import Diagnostic from "./screens/Diagnostic.jsx";
import Plan from "./screens/Plan.jsx";
import Lesson from "./screens/Lesson.jsx";
import Check from "./screens/Check.jsx";
import Summary from "./screens/Summary.jsx";
import Notice from "./components/Notice.jsx";
import { forgetLoaded } from "./useLoad.js";
import { DATA_NOTICE_SHORT } from "./privacy.js";

// There are no accounts: the session id in localStorage is the only thing this browser keeps, and
// the server is the record of everything else. A reload starts a new session.
const STORAGE_KEY = "clario.sessionId";

// What the progress line shows: a lesson is part of working through the plan, so it does not get
// its own stage.
const STAGES = ["diagnose", "plan", "check", "summary"];

export default function App() {
  const [session, setSession] = useState(null);
  const [phase, setPhase] = useState("start");
  const [stepIndex, setStepIndex] = useState(0);

  function start(started) {
    forgetLoaded();
    try {
      window.localStorage.setItem(STORAGE_KEY, started.sessionId);
    } catch {
      // A browser with storage disabled still gets a working session; only the id is lost.
    }
    setSession({
      sessionId: started.sessionId,
      topic: started.topic,
      packStatus: started.packStatus,
      firstQuestion: started.firstQuestion,
    });
    setStepIndex(0);
    setPhase(started.firstQuestion ? "diagnose" : "plan");
  }

  function restart() {
    forgetLoaded();
    setSession(null);
    setPhase("start");
  }

  if (!session) return <Start onStarted={start} />;

  const stage = STAGES.indexOf(phase === "lesson" ? "plan" : phase);

  return (
    <div className="app">
      <header className="top">
        <button type="button" className="top__brand" onClick={restart}>
          Clario
        </button>
        <span className="tag tag--beta">Beta</span>
        <p className="top__topic">{session.topic}</p>
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
      </header>

      {session.packStatus === "generated" ? (
        <Notice tone="info">
          This topic was written for you by the assistant and has not been reviewed: treat its
          content as generated and unverified, and check it against your course material.
        </Notice>
      ) : null}

      <main className="main">
        {phase === "diagnose" ? (
          <Diagnostic session={session} onDone={() => setPhase("plan")} />
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

        {phase === "check" ? <Check session={session} onDone={() => setPhase("summary")} /> : null}

        {phase === "summary" ? <Summary session={session} onRestart={restart} /> : null}
      </main>

      <footer className="foot">
        <p className="foot__text">{DATA_NOTICE_SHORT}</p>
      </footer>
    </div>
  );
}
