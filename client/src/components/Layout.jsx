import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";

export default function Layout({ children }) {
  const { user, logout, isAuthenticated } = useAuth();

  return (
    <div className="layout">
      <header className="layout__header">
        <Link to="/topics" className="layout__brand">
          Clario
        </Link>
        <nav className="layout__nav">
          {isAuthenticated ? (
            <>
              <Link to="/topics">Topics</Link>
              <Link to="/sessions">Sessions</Link>
              {user.role === "admin" && (
                <>
                  <Link to="/admin/packs">Packs</Link>
                  <Link to="/admin/users">Users</Link>
                  <Link to="/admin/analytics">Analytics</Link>
                </>
              )}
              <button type="button" className="button" onClick={logout}>
                Logout
              </button>
            </>
          ) : (
            <>
              <Link to="/login">Login</Link>
              <Link to="/register">Register</Link>
            </>
          )}
        </nav>
      </header>
      <main className="layout__main">{children}</main>
    </div>
  );
}
