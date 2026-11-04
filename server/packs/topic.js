// The topic string itself: what a student typed, checked and normalized.
//
// Both the pack generator (offline script) and the session routes need the same answer to
// "is this a usable topic, and what is its cache key", so it lives here rather than in either.

const MAX_TOPIC_LENGTH = 120;

class InvalidTopicError extends Error {
  constructor(message) {
    super(message);
    this.name = "InvalidTopicError";
    this.status = 400;
    this.code = "invalid_topic";
    this.expose = true;
  }
}

// Throws InvalidTopicError, or returns the topic with outer spaces and runs of whitespace
// collapsed. The cache key is this value lowercased.
function normalizeTopic(topic) {
  if (typeof topic !== "string") throw new InvalidTopicError("Enter a topic as text.");
  if ([...topic].length > MAX_TOPIC_LENGTH) {
    throw new InvalidTopicError(`Keep the topic under ${MAX_TOPIC_LENGTH} characters.`);
  }
  const collapsed = topic.trim().replace(/\s+/g, " ");
  if (!collapsed) throw new InvalidTopicError("Enter a topic first.");
  return collapsed;
}

module.exports = { MAX_TOPIC_LENGTH, InvalidTopicError, normalizeTopic };
