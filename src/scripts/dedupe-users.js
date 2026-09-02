/**
 * Merge duplicate user rows that share the same email (case variants).
 * Keeps the best account (active + logged in > invite pending > newest).
 *
 * Usage: npm run dedupe:users
 */
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/user.model');

function scoreUser(user) {
  let score = 0;
  if (user.isActive !== false) score += 100;
  if (user.lastLoginAt) score += 50;
  if (!user.invitePending) score += 25;
  if (user.googleId) score += 10;
  score += new Date(user.updatedAt || user.createdAt || 0).getTime() / 1e12;
  return score;
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri || uri.includes('<db_password>')) {
    console.error('Set a real MONGO_URI in backend/.env before running.');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log('Connected. Scanning for duplicate emails…');

  const users = await User.find({}).sort({ createdAt: 1 }).lean();
  const groups = new Map();

  for (const user of users) {
    const key = String(user.email || '').toLowerCase().trim();
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(user);
  }

  let removed = 0;
  let normalized = 0;

  for (const [email, group] of groups.entries()) {
    if (group.length === 1) {
      const only = group[0];
      if (only.email !== email) {
        await User.updateOne({ _id: only._id }, { $set: { email } });
        normalized += 1;
      }
      continue;
    }

    const sorted = [...group].sort((a, b) => scoreUser(b) - scoreUser(a));
    const keeper = sorted[0];
    const duplicates = sorted.slice(1);

    if (keeper.email !== email) {
      await User.updateOne({ _id: keeper._id }, { $set: { email } });
      normalized += 1;
    }

    for (const dup of duplicates) {
      await User.deleteOne({ _id: dup._id });
      removed += 1;
      console.log(`Removed duplicate ${dup.email} (${dup.role}) — kept ${keeper.email} (${keeper.role})`);
    }
  }

  console.log({ duplicateGroups: [...groups.values()].filter((g) => g.length > 1).length, removed, normalized });
  await mongoose.disconnect();
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
