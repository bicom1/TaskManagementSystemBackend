/**
 * Safe additive sync: ensure every team member is on that team's projects.
 * Does NOT wipe data. Usage: node src/scripts/sync-team-project-members.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Team = require('../models/team.model');
const Project = require('../models/project.model');

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri || uri.includes('<db_password>')) {
    console.error('Set MONGO_URI in backend/.env');
    process.exit(1);
  }

  await mongoose.connect(uri);
  const teams = await Team.find({ isActive: { $ne: false } })
    .select('_id name lead members')
    .lean();

  let updated = 0;
  for (const team of teams) {
    const memberIds = [
      team.lead,
      ...(team.members || []),
    ].filter(Boolean);

    if (!memberIds.length) continue;

    const result = await Project.updateMany(
      { team: team._id },
      { $addToSet: { members: { $each: memberIds } } }
    );
    if (result.modifiedCount) {
      updated += result.modifiedCount;
      console.log(`Synced ${result.modifiedCount} project(s) for team "${team.name}"`);
    }
  }

  console.log(`Done. Projects updated: ${updated}`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
