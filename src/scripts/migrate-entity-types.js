#!/usr/bin/env node
/**
 * Corrects entityType on notifications and activity-log entries written before
 * 'Team' and 'Department' existed as entity types.
 *
 * Team and department events were stored as 'Project' with a team or department
 * id, so clicking them opened a "project not found" page. User events in the
 * activity log were also stored as 'Project', so the audit log mislabelled them.
 *
 * Only the entityType field changes — ids, messages and read state are untouched.
 * Dry run by default; writes a backup of every row it would change.
 *   npm run migrate:entity-types            # dry run
 *   npm run migrate:entity-types -- --apply # apply
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const env = require('../config/env');

const APPLY = process.argv.includes('--apply');
const USER_ACTIONS = ['user_invited', 'user_updated', 'user_deleted'];

async function idSet(db, collection) {
  const rows = await db.collection(collection).find({}, { projection: { _id: 1 } }).toArray();
  return new Set(rows.map((r) => String(r._id)));
}

(async () => {
  await mongoose.connect(env.MONGO_URI);
  const db = mongoose.connection.db;
  const [teams, departments] = await Promise.all([idSet(db, 'teams'), idSet(db, 'departments')]);

  // Notifications: decide by what the id really is — never by message text.
  const projectTyped = await db
    .collection('notifications')
    .find({ entityType: 'Project' }, { projection: { entityId: 1, type: 1 } })
    .toArray();
  const toTeam = projectTyped.filter((n) => teams.has(String(n.entityId)));
  const toDepartment = projectTyped.filter((n) => departments.has(String(n.entityId)));

  // Activity log: user_* actions were only ever written by user.service, so the
  // action identifies the entity even where that user has since been deleted.
  const userLogs = await db
    .collection('activitylogs')
    .find({ entityType: 'Project', action: { $in: USER_ACTIONS } }, { projection: { entityId: 1, action: 1 } })
    .toArray();

  const tally = (rows, key) =>
    rows.reduce((acc, r) => ({ ...acc, [r[key]]: (acc[r[key]] || 0) + 1 }), {});

  console.log(APPLY ? 'APPLYING migration\n' : 'DRY RUN — nothing will be changed (pass --apply)\n');
  console.log(`notifications  Project → Team        ${toTeam.length}`, tally(toTeam, 'type'));
  console.log(`notifications  Project → Department  ${toDepartment.length}`, tally(toDepartment, 'type'));
  console.log(`activitylogs   Project → User        ${userLogs.length}`, tally(userLogs, 'action'));

  if (!APPLY) {
    await mongoose.disconnect();
    return;
  }

  // backups/ is gitignored — never commit exports of production data.
  const backupDir = path.join(process.cwd(), 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(
    backupDir,
    `entity-type-migration-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  );
  fs.writeFileSync(
    backupPath,
    JSON.stringify(
      {
        note: 'Every row below had entityType "Project" before migration.',
        notificationsToTeam: toTeam.map((r) => r._id),
        notificationsToDepartment: toDepartment.map((r) => r._id),
        activityLogsToUser: userLogs.map((r) => r._id),
      },
      null,
      2
    )
  );

  const [t, d, u] = await Promise.all([
    db.collection('notifications').updateMany(
      { _id: { $in: toTeam.map((r) => r._id) }, entityType: 'Project' },
      { $set: { entityType: 'Team' } }
    ),
    db.collection('notifications').updateMany(
      { _id: { $in: toDepartment.map((r) => r._id) }, entityType: 'Project' },
      { $set: { entityType: 'Department' } }
    ),
    db.collection('activitylogs').updateMany(
      { _id: { $in: userLogs.map((r) => r._id) }, entityType: 'Project' },
      { $set: { entityType: 'User' } }
    ),
  ]);

  console.log(`\nUpdated: ${t.modifiedCount} → Team, ${d.modifiedCount} → Department, ${u.modifiedCount} → User`);
  console.log(`Backup of changed ids: ${backupPath}`);
  await mongoose.disconnect();
})().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
