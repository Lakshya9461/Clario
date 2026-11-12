// Operator-only teardown for tester data: every session, every evidence event, every generated
// pack. Curated packs are files in packs/ and are never touched here.
//
// Nothing else in the app deletes evidence: this script exists so the beta's data can be cleared
// in one deliberate step, and so that step cannot be run by accident.
//
//   node scripts/teardown.js --dry-run        # counts only, deletes nothing
//   node scripts/teardown.js --yes            # deletes
//
// Safety:
//  - MONGO_URL must be set explicitly (in server/.env or the environment). The script refuses to
//    fall back to the local default, so it can never delete a database nobody named.
//  - Deleting requires --yes; without it the script prints the counts and exits non-zero.
//  - Only these three collections are touched, and only in deleteMany with no filter.

require("dotenv").config();

const { connect, disconnect, mongoUrl, redactUrl } = require("../config/db");
const { Session, EvidenceEvent, Pack } = require("../models/models");

const DELETE_FLAGS = new Set(["--yes", "--force"]);
const DRY_RUN_FLAGS = new Set(["--dry-run", "-n"]);

function parseArgs(argv) {
  const flags = new Set(argv);
  const unknown = argv.filter((arg) => !DELETE_FLAGS.has(arg) && !DRY_RUN_FLAGS.has(arg));
  return {
    dryRun: argv.some((arg) => DRY_RUN_FLAGS.has(arg)),
    confirmed: argv.some((arg) => DELETE_FLAGS.has(arg)),
    unknown,
  };
}

async function counts() {
  return {
    sessions: await Session.countDocuments({}),
    evidenceEvents: await EvidenceEvent.countDocuments({}),
    generatedPacks: await Pack.countDocuments({}),
  };
}

async function main() {
  const { dryRun, confirmed, unknown } = parseArgs(process.argv.slice(2));

  if (!process.env.MONGO_URL) {
    console.error(
      "MONGO_URL is not set. Refusing to guess: set it in server/.env or the environment so the " +
        "teardown can never run against a database nobody named."
    );
    process.exitCode = 1;
    return;
  }

  if (unknown.length) {
    console.error(`Unknown argument(s): ${unknown.join(" ")}`);
    console.error("Usage: node scripts/teardown.js [--dry-run] [--yes]");
    process.exitCode = 1;
    return;
  }

  console.log(`database: ${redactUrl(mongoUrl())}`);
  await connect();

  const before = await counts();
  console.log(
    `before: ${before.sessions} sessions, ${before.evidenceEvents} evidence events, ` +
      `${before.generatedPacks} generated packs`
  );

  if (dryRun) {
    console.log("dry run: nothing deleted. Run again with --yes to delete.");
    await disconnect();
    return;
  }

  if (!confirmed) {
    console.log("nothing deleted: pass --yes to delete the rows above, or --dry-run to only count.");
    process.exitCode = 1;
    await disconnect();
    return;
  }

  // Evidence first: it points at sessions, so it goes before the sessions it describes.
  const evidence = await EvidenceEvent.deleteMany({});
  const sessions = await Session.deleteMany({});
  const packs = await Pack.deleteMany({});
  console.log(
    `deleted: ${evidence.deletedCount} evidence events, ${sessions.deletedCount} sessions, ` +
      `${packs.deletedCount} generated packs`
  );

  const after = await counts();
  console.log(
    `after: ${after.sessions} sessions, ${after.evidenceEvents} evidence events, ` +
      `${after.generatedPacks} generated packs`
  );
  await disconnect();
}

main().catch(async (error) => {
  console.error(`teardown failed: ${error.message}`);
  await disconnect().catch(() => {});
  process.exitCode = 1;
});
