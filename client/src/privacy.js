// What the beta tells a student about the record it keeps.
//
// This is a claim about the system, so it has to stay true: the answers really are stored on this
// server under a random session id, a written answer really is sent to the model provider to be
// graded, and there really are no accounts or analytics. If any of that changes, this file changes
// with it — the notice is kept in one place so the two screens cannot drift apart.

export const DATA_NOTICE =
  "Your answers are saved on this server under a random session id kept in this browser, so the " +
  "plan and the results can be built from them. A written answer is sent to the language-model " +
  "provider to be graded. There are no accounts and no analytics. Please do not paste personal " +
  "information into an answer.";

export const DATA_NOTICE_SHORT =
  "Beta. Answers are saved on this server and written ones are sent to the model provider to be " +
  "graded. No accounts, no analytics.";
