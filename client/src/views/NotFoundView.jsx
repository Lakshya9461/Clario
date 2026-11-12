import { Link } from "react-router-dom";

export default function NotFoundView() {
  return (
    <section className="not-found">
      <h1 className="not-found__title">404 &mdash; Page not found</h1>
      <p className="not-found__lede">
        The page you&apos;re looking for doesn&apos;t exist. Return to a working
        screen.
      </p>
      <div className="not-found__actions">
        <Link to="/login" className="button button--primary">Go to Login</Link>
        <Link to="/topics" className="button">Go to Topics</Link>
      </div>
    </section>
  );
}
