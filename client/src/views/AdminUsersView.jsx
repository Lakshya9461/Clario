import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Busy } from "../components/Status.jsx";

const MOCK_USERS = [
  { id: "u1", email: "admin@clario.test", name: "Administrator", role: "admin" },
  { id: "u2", email: "alice@example.test", name: "Alice Chen", role: "student" },
  { id: "u3", email: "bob@example.test", name: "Bob Rivera", role: "student" },
  { id: "u4", email: "carol@example.test", name: "Carol Kim", role: "student" },
];

export default function AdminUsersView() {
  const [users, setUsers] = useState([]);
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    let active = true;
    setTimeout(() => {
      if (active) {
        setUsers(MOCK_USERS);
        setBusy(false);
      }
    }, 500);
    return () => {
      active = false;
    };
  }, []);

  if (busy) return <Busy label="Loading users…" />;

  return (
    <section className="admin">
      <h1 className="admin__title">Users</h1>
      <p className="admin__lede">
        Registered users and their roles. This is mock data until the backend
        exposes user management endpoints.
      </p>
      {users.length === 0 ? (
        <div className="empty">
          <p className="empty__text">No users found.</p>
        </div>
      ) : (
        <table className="admin__table">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Email</th>
              <th scope="col">Role</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id} className="admin__row">
                <td className="admin__name">{user.name}</td>
                <td className="admin__email">{user.email}</td>
                <td className="admin__role">
                  <span className={`badge badge--${user.role}`}>{user.role}</span>
                </td>
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
