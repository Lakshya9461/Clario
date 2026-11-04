// One short message. `tone` decides how loud it is, and an error is announced to screen readers.
export default function Notice({ tone = "info", children }) {
  return (
    <p className={`notice notice--${tone}`} role={tone === "error" ? "alert" : undefined}>
      {children}
    </p>
  );
}
