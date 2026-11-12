// The query string every list route shares: what a page means, and how a search string reaches the
// store.
//
// One module rather than three, so the listings cannot drift: the same envelope, the same page cap,
// and the same rule that an empty query value means "not set" rather than "match nothing". `?q=` is
// what an empty search box submits, and it must not empty the table.
//
// The text helpers live here too. A search is always a literal substring, never a pattern the caller
// supplied: a student searching for "a.*b" must find that text, not every row. An unescaped regex is
// how a query string turns into a scan of the whole collection.

const { z } = require("zod");

const DEFAULT_LIMIT = 20;
// A page is a screenful. A caller asking for thousands is scraping or retrying badly, and either
// way the server pays for it.
const MAX_LIMIT = 50;
const MAX_QUERY_TEXT = 100;

// `?page=` and `?page` mean the same thing: the field was not set.
const absent = (schema) => z.preprocess((value) => (value === "" ? undefined : value), schema);

// A free-text field of a query string: trimmed, bounded, and absent when empty. It never throws on
// a missing field, because "no search" is the common case.
function queryText() {
  return absent(z.string().trim().min(1).max(MAX_QUERY_TEXT).optional());
}

// One of a fixed set, or absent. Used for the admin filters, where an unknown value is a client bug
// the route should refuse instead of silently ignoring.
function queryEnum(values) {
  return absent(z.enum(values).optional());
}

// The two fields every listing has, plus whatever the route adds. Unknown keys are stripped, so a
// caller cannot smuggle a filter (an owner, a role) a handler does not read.
function listSchema(extra = {}) {
  return z.object({
    page: absent(z.coerce.number().int().min(1).default(1)),
    limit: absent(z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT)),
    ...extra,
  });
}

// The rows already read. A page number, not an offset: the client asks for "the next page".
function skipFor({ page, limit }) {
  return (page - 1) * limit;
}

// One envelope for every list, so a client never has to ask which route it is looking at.
function paginate(items, total, { page, limit }) {
  return { items, page, limit, total, totalPages: Math.ceil(total / limit) };
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A search: the text appears somewhere in the field, ignoring case.
function containsText(text) {
  return { $regex: escapeRegExp(text), $options: "i" };
}

// A filter: the field is exactly this value, ignoring case.
function sameText(text) {
  return { $regex: `^${escapeRegExp(text)}$`, $options: "i" };
}

module.exports = {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  MAX_QUERY_TEXT,
  listSchema,
  queryEnum,
  queryText,
  skipFor,
  paginate,
  containsText,
  sameText,
};
