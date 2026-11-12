import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Busy } from "../components/Status.jsx";

const MOCK_PACKS = [  { packId: "sample-topic-a", topic: "JavaScript fundamentals", status: "curated", version: "0.1-beta", concepts: 8 },
  { packId: "generated-react", topic: "React basics", status: "generated", version: "0.1-beta", concepts: 10 },
  { packId: "generated-python", topic: "Python for data", status: "generated", version: "0.1-beta", concepts: 6 },
];
export default function AdminPacksView() {
  const [packs, setPacks] = useState([]);
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    let active = true;
    setTimeout(() => {
      if (active) {
        setPacks(MOCK_PACKS);
        setBusy(false);
      }
    }, 500);
    return () => {
      active = false;
    };
  }, []);

  if (busy) return <Busy label="Loading packs…" />;

  return (
    <section className="admin">
      <h1 className="admin__title">Packs</h1>
      <p className="admin__lede">
        Curated and generated topic packs. This is mock data until the backend
        exposes pack management endpoints.
      </p>
      {packs.length === 0 ? (
        <div className="empty">
          <p className="empty__text">No packs found.</p>
        </div>
      ) : (
        <table className="admin__table">
          <thead>
            <tr>
              <th scope="col">Pack</th>
              <th scope="col">Topic</th>
              <th scope="col">Status</th>
              <th scope="col">Version</th>
              <th scope="col">Concepts</th>
            </tr>
          </thead>
          <tbody>
            {packs.map((pack) => (
              <tr key={pack.packId} className="admin__row">
                <td className="admin__pack-id">{pack.packId}</td>
                <td className="admin__topic">{pack.topic}</td>
                <td className="admin__status">
                  <span className={`badge badge--${pack.status}`}>
                    {pack.status}
                  </span>
                </td>
                <td className="admin__version">{pack.version}</td>
                <td className="admin__concepts">{pack.concepts}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="admin__hint">
        <Link to="/topics">Return to Topics</Link>
      </p>
    </section>
  );
}
