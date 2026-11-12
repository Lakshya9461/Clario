require("dotenv").config();

const bcrypt = require("bcryptjs");
const { assertBootable } = require("../config/env");
const db = require("../config/db");
const { User } = require("../models/user");

async function main() {
  const config = assertBootable();
  if (!config.admin.email || !config.admin.password) {
    throw new Error("ADMIN_EMAIL and ADMIN_PASSWORD are required to seed an admin.");
  }
  await db.connect();
  const email = config.admin.email.toLowerCase();
  const passwordHash = await bcrypt.hash(config.admin.password, 12);
  await User.findOneAndUpdate(
    { email },
    { $set: { name: "Administrator", email, passwordHash, role: "admin" } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  console.log(`admin seeded: ${email}`);
  await db.disconnect();
}

main().catch(async (error) => {
  console.error(error.message);
  try {
    await db.disconnect();
  } catch {}
  process.exitCode = 1;
});
