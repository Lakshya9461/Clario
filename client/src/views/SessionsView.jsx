import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { auth } from "../auth.js";
import { Busy, Failure } from "../components/Status.jsx";

export default function SessionsView() {
  const [sessions, setSessions] = useState([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const data = await auth.sessions();
        if (active) setSessions(Array.isArray(data) ? data : []);
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

  if (busy) return <Busy label="Loading your sessions…" />;
  if (error) return <Failure error={error} onRetry={() => window.location.reload()} />;

  return (
    <section className="sessions">
      <h1 className="sessions__title">Your sessions</h1>
      <p className="sessions__lede">
        Return to any session to continue where you left off.
      </p>

      {sessions.length === 0 ? (
        <div className="empty">
          <p className="empty__text">You haven&apos;t started any sessions yet.</p>
          <p className="empty__hint">
            Start one from <Link to="/topics">Topics</Link>.
          </p>
        </div>
      ) : (
        <table className="sessions__table">
          <thead>
            <tr>
              <th scope="col">Topic</th>
              <th scope="col">Pack</th>
              <th scope="col">Started</th>
              <th scope="col" className="sessions__th-action">
                Action
              </th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((session) => (
              <tr key={session.id} className="sessions__row">
                <td className="sessions__topic">{session.topic}</td>
                <td className="sessions__pack">
                  {session.packStatus === "curated" ? "Curated" : "Generated"}
                </td>
                <td className="sessions__date">
                  {new Date(session.createdAt).toLocaleDateString()}
                </td>
                <td className="sessions__action">
                  <Link to={`/learn/${session.id}`} className="button">
                    Continue
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
