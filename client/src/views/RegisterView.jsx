import { useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";
import Notice from "../components/Notice.jsx";

export default function RegisterView() {
  const { register, loading } = useAuth();
  const [form, setForm] = useState({
    name: "",
    email: "",
    password: "",
    confirmPassword: "",
  });
  const [errors, setErrors] = useState({});
  const [submitError, setSubmitError] = useState(null);

  function validate() {
    const e = {};
    if (!form.name.trim()) {
      e.name = "Full name is required.";
    }
    if (!form.email.trim()) {
      e.email = "Email is required.";
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) {
      e.email = "Enter a valid email address.";
    }
    if (!form.password) {
      e.password = "Password is required.";
    } else if (form.password.length < 8) {
      e.password = "Password must be at least 8 characters.";
    }
    if (!form.confirmPassword) {
      e.confirmPassword = "Please confirm your password.";
    } else if (form.password !== form.confirmPassword) {
      e.confirmPassword = "Passwords do not match.";
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (!validate()) return;
    setSubmitError(null);
    try {
      await register(form);
    } catch (failure) {
      setSubmitError(failure.message || "Registration failed. Try again.");
    }
  }

  return (
    <section className="auth">
      <div className="auth__card">
        <h2 className="auth__title">Create an account</h2>
        <p className="auth__lede">
          Register to start tracking your learning sessions. This beta uses mock
          auth until the backend exposes real registration endpoints.
        </p>
        {submitError ? <Notice tone="error">{submitError}</Notice> : null}
        <form onSubmit={handleSubmit} className="auth__form">
          <div className="field">
            <label className="field__label">Full name</label>
            <input
              type="text"
              name="name"
              autoComplete="name"
              value={form.name}
              onChange={(event) =>
                setForm({ ...form, name: event.target.value })
              }
              aria-invalid={!!errors.name}
              aria-describedby={errors.name ? "register-name-error" : undefined}
            />
            {errors.name ? (
              <p id="register-name-error" className="field__error">
                {errors.name}
              </p>
            ) : null}
          </div>
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
              aria-describedby={
                errors.email ? "register-email-error" : undefined
              }
            />
            {errors.email ? (
              <p id="register-email-error" className="field__error">
                {errors.email}
              </p>
            ) : null}
          </div>
          <div className="field">
            <label className="field__label">Password</label>
            <input
              type="password"
              name="password"
              autoComplete="new-password"
              value={form.password}
              onChange={(event) =>
                setForm({ ...form, password: event.target.value })
              }
              aria-invalid={!!errors.password}
              aria-describedby={
                errors.password ? "register-password-error" : undefined
              }
            />
            {errors.password ? (
              <p id="register-password-error" className="field__error">
                {errors.password}
              </p>
            ) : null}
          </div>
          <div className="field">
            <label className="field__label">Confirm password</label>
            <input
              type="password"
              name="confirmPassword"
              autoComplete="new-password"
              value={form.confirmPassword}
              onChange={(event) =>
                setForm({ ...form, confirmPassword: event.target.value })
              }
              aria-invalid={!!errors.confirmPassword}
              aria-describedby={
                errors.confirmPassword ? "register-confirm-error" : undefined
              }
            />
            {errors.confirmPassword ? (
              <p id="register-confirm-error" className="field__error">
                {errors.confirmPassword}
              </p>
            ) : null}
          </div>
          <button
            type="submit"
            className="button button--primary"
            disabled={loading}
          >
            {loading ? "Creating account…" : "Create account"}
          </button>
        </form>
        <p className="auth__switch">
          Already have an account? <Link to="/login">Sign in</Link>
        </p>
      </div>
    </section>
  );
}
