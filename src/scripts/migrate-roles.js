/**
 * Migrate legacy roles → SUPERADMIN | ADMIN | MEMBER (no data loss).
 * Usage: node src/scripts/migrate-roles.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/user.model');
const { normalizeRole, ROLE_VALUES } = require('../constants/roles.constant');

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri || uri.includes('<db_password>')) {
    console.error('Set a real MONGO_URI in backend/.env before running.');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log('Connected. Migrating user roles…');

  const users = await User.find({}).select('_id email role');
  let updated = 0;
  const counts = { SUPERADMIN: 0, ADMIN: 0, MEMBER: 0 };

  for (const user of users) {
    const next = normalizeRole(user.role);
    counts[next] = (counts[next] || 0) + 1;
    if (user.role !== next) {
      // Bypass enum temporarily if old value still on doc — use updateOne
      await User.collection.updateOne({ _id: user._id }, { $set: { role: next } });
      updated += 1;
      console.log(`  ${user.email}: ${user.role} → ${next}`);
    }
  }

  // Clear any role values outside the canonical set
  const invalid = await User.collection.updateMany(
    { role: { $nin: ROLE_VALUES } },
    { $set: { role: 'MEMBER' } }
  );

  console.log({
    total: users.length,
    updated,
    forcedMember: invalid.modifiedCount,
    counts,
  });

  await mongoose.disconnect();
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
