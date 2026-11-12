// The query string of every list route: what a page means, and how a search string reaches the
// store. Unit tests, because these are the rules every listing shares.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  containsText,
  listSchema,
  paginate,
  queryText,
  sameText,
  skipFor,
} = require("./list-query");

test("a page has a default size and starts at the first page", () => {
  assert.deepEqual(listSchema().parse({}), { page: 1, limit: DEFAULT_LIMIT });
  assert.deepEqual(listSchema().parse({ page: "3", limit: "5" }), { page: 3, limit: 5 });
});

test("an empty value means the field was not set, not zero and not an empty search", () => {
  assert.deepEqual(listSchema().parse({ page: "", limit: "" }), { page: 1, limit: DEFAULT_LIMIT });
  const withSearch = listSchema({ q: queryText() });
  const parsed = withSearch.parse({ q: "" });
  assert.equal(parsed.q, undefined);
  assert.deepEqual(withSearch.parse({ q: "  recursion  " }).q, "recursion");
});

test("the page size is capped, and nonsense is refused instead of guessed", () => {
  assert.equal(listSchema().safeParse({ limit: String(MAX_LIMIT) }).success, true);
  for (const limit of [String(MAX_LIMIT + 1), "0", "-1", "1.5", "abc"]) {
    assert.equal(listSchema().safeParse({ limit }).success, false, `limit=${limit}`);
  }
  for (const page of ["0", "-2", "abc"]) {
    assert.equal(listSchema().safeParse({ page }).success, false, `page=${page}`);
  }
});

test("only the fields the route asked for survive the query string", () => {
  const parsed = listSchema({ topic: queryText() }).parse({
    topic: "anything",
    userId: "someone-else",
    role: "admin",
  });
  assert.deepEqual(parsed, { page: 1, limit: DEFAULT_LIMIT, topic: "anything" });
});

test("the skip is the pages already read, and totalPages counts whole pages", () => {
  assert.equal(skipFor({ page: 1, limit: 20 }), 0);
  assert.equal(skipFor({ page: 3, limit: 20 }), 40);

  assert.deepEqual(paginate(["a"], 1, { page: 1, limit: 20 }), {
    items: ["a"],
    page: 1,
    limit: 20,
    total: 1,
    totalPages: 1,
  });
  assert.equal(paginate([], 40, { page: 2, limit: 20 }).totalPages, 2);
  assert.equal(paginate([], 41, { page: 3, limit: 20 }).totalPages, 3);
  assert.equal(paginate([], 0, { page: 1, limit: 20 }).totalPages, 0, "no rows is no pages");
});

test("a search is a literal substring, so a regex character finds itself", () => {
  assert.deepEqual(containsText("a.*b"), { $regex: "a\\.\\*b", $options: "i" });
  assert.deepEqual(containsText("C++"), { $regex: "C\\+\\+", $options: "i" });
  assert.deepEqual(containsText("(x)[y]{z}"), { $regex: "\\(x\\)\\[y\\]\\{z\\}", $options: "i" });
});

test("a topic filter matches the whole value, ignoring case", () => {
  assert.deepEqual(sameText("Sample Topic"), { $regex: "^Sample Topic$", $options: "i" });
  assert.deepEqual(sameText("a.b"), { $regex: "^a\\.b$", $options: "i" });
});
