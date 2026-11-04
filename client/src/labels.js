// The words the UI is allowed to use about evidence.
//
// A4: a generated pack's "demonstrated" is weaker than a curated, code-keyed one, so it is shown
// as "likely demonstrated". "unknown" is unassessed and never a weakness. Nothing here may say a
// student does not understand something: the evidence only ever supports "not much recorded yet".

export const STATUS_LABEL = {
  unknown: "not assessed yet",
  self_reported: "only your own report",
  developing: "still working on it",
  demonstrated: "demonstrated",
};

// `certainty` is computed by the server so the client never has to work the rule out itself.
export function statusLabel(finding) {
  if (finding.status === "demonstrated" && finding.certainty) return finding.certainty;
  return STATUS_LABEL[finding.status] ?? STATUS_LABEL.unknown;
}

export const CONFIDENCE_LABEL = {
  none: "no evidence yet",
  low: "a little evidence",
  moderate: "some evidence",
  high: "consistent evidence",
};

export const GOALS = [
  { value: "exam", label: "an exam" },
  { value: "course", label: "a course" },
  { value: "assignment", label: "an assignment" },
  { value: "curiosity", label: "curiosity" },
];

export function kindLabel(question) {
  switch (question.kind) {
    case "mcq":
      return "multiple choice";
    case "free_text":
      return "written answer";
    case "predict_output":
      return "predict the output";
    default:
      return String(question.kind);
  }
}
