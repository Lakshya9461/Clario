import { useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";
import Notice from "../components/Notice.jsx";

export default function LoginView() {
  const { login, loading } = useAuth();
  const [form, setForm] = useState({ email: "", password: "" });
  const [errors, setErrors] = useState({});
  const [submitError, setSubmitError] = useState(null);

  function validate() {
    const e = {};
    if (!form.email.trim()) {
      e.email = "Email is required.";
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) {
      e.email = "Enter a valid email address.";
    }
    if (!form.password) {
      e.password = "Password is required.";
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (!validate()) return;
    setSubmitError(null);
    try {
      await login(form);
    } catch (failure) {
      setSubmitError(failure.message || "Login failed. Try again.");
    }
  }

  return (
    <section className="auth">
      <div className="auth__card">
        <h2 className="auth__title">Sign in</h2>
        <p className="auth__lede">
          Enter your credentials to continue. This beta uses mock auth until the
          backend exposes real login endpoints.
        </p>
        {submitError ? <Notice tone="error">{submitError}</Notice> : null}
        <form onSubmit={handleSubmit} className="auth__form">
          <div className="field">
            <label className="field__label">Email</label>
            <input
              type="email"
              name="email"
              autoComplete="email"
              value={form.email}
              onChange={(event) =>
                setForm({ ...form, email: event.target.value })
              }
              aria-invalid={!!errors.email}
              aria-describedby={errors.email ? "login-email-error" : undefined}
            />
            {errors.email ? (
              <p id="login-email-error" className="field__error">
                {errors.email}
              </p>
            ) : null}
          </div>
          <div className="field">
            <label className="field__label">Password</label>
            <input
              type="password"
              name="password"
              autoComplete="current-password"
              value={form.password}
              onChange={(event) =>
                setForm({ ...form, password: event.target.value })
              }
              aria-invalid={!!errors.password}
              aria-describedby={
                errors.password ? "login-password-error" : undefined
              }
            />
            {errors.password ? (
              <p id="login-password-error" className="field__error">
                {errors.password}
              </p>
            ) : null}
          </div>
          <button
            type="submit"
            className="button button--primary"
            disabled={loading}
          >
            {loading ? "Signing in…" : "Sign in"}
          </button>
        </form>
        <p className="auth__switch">
          Don&apos;t have an account?{" "}
          <Link to="/register">Create one</Link>
        </p>
        <p className="auth__hint">
          Try admin@clario.test for admin access, any other email for student
          access. Any password works.
        </p>
      </div>
    </section>
  );
}
