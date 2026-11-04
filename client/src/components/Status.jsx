// The two states every model-backed screen has: waiting, and having failed.
//
// Waiting says what is happening, because several of these calls take five to fifteen seconds and
// a bare spinner reads as a broken page. A failure keeps the server's own message and offers one
// retry rather than a dead end.

export function Busy({ label }) {
  return (
    <div className="busy" role="status" aria-live="polite">
      <span className="busy__dot" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function Failure({ error, onRetry }) {
  return (
    <div className="failure">
      <p className="notice notice--error" role="alert">
        {error?.message || "Something went wrong."}
      </p>
      <p className="failure__hint">
        {error?.code === "busy"
          ? "The study assistant is answering someone else. Give it a moment."
          : error?.code === "topic_not_available"
            ? "This beta serves topics that have already been prepared."
            : error?.code === "session_not_found"
              ? "Start a new session from the beginning."
              : "Nothing was lost: your session is stored on the server."}
      </p>
      <button type="button" className="button" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}
