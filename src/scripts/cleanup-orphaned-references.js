#!/usr/bin/env node
/**
 * One-off cleanup of references left behind by task and project deletions made
 * before deletionCleanup.service existed. New deletions clean up after
 * themselves; this only clears the backlog.
 *
 * Dry run by default — prints what it would remove and changes nothing.
 *   npm run cleanup:orphans            # dry run
 *   npm run cleanup:orphans -- --apply # actually delete
 *
 * Safety rules, mirroring deletionCleanup.service:
 *  - Deletion notices (task_deleted / project_deleted / user_deleted) are the
 *    audit trail and are always kept.
 *  - Team and department notifications were historically stored with entityType
 *    'Project' (see scripts/migrate-entity-types.js). As a guard for any row the
 *    migration did not reach, a "Project" notification is only treated as
 *    orphaned when its id is not a project AND not a team, department or user.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const env = require('../config/env');
const { AUDIT_TYPES } = require('../services/deletionCleanup.service');

const APPLY = process.argv.includes('--apply');

async function idSet(db, collection, filter = {}) {
  const rows = await db.collection(collection).find(filter, { projection: { _id: 1 } }).toArray();
  return new Set(rows.map((r) => String(r._id)));
}

(async () => {
  await mongoose.connect(env.MONGO_URI);
  const db = mongoose.connection.db;

  const [projects, teams, departments, users, liveTasks] = await Promise.all([
    idSet(db, 'projects'),
    idSet(db, 'teams'),
    idSet(db, 'departments'),
    idSet(db, 'users'),
    idSet(db, 'tasks', { isArchived: { $ne: true } }),
  ]);
  const otherEntities = new Set([...teams, ...departments, ...users]);

  const candidates = await db
    .collection('notifications')
    .find(
      { entityType: { $in: ['Task', 'Project'] }, type: { $nin: AUDIT_TYPES } },
      { projection: { entityType: 1, entityId: 1, type: 1, isRead: 1 } }
    )
    .toArray();

  const orphaned = candidates.filter((n) => {
    const id = String(n.entityId);
    if (n.entityType === 'Task') return !liveTasks.has(id);
    return !projects.has(id) && !otherEntities.has(id);
  });

  const byType = {};
  for (const n of orphaned) byType[n.type] = (byType[n.type] || 0) + 1;

  const usersWithDeadItems = await db
    .collection('users')
    .find({ 'preferences.personalList.0': { $exists: true } }, { projection: { 'preferences.personalList': 1 } })
    .toArray();
  let deadPersonal = 0;
  for (const u of usersWithDeadItems) {
    deadPersonal += (u.preferences.personalList || []).filter((t) => !liveTasks.has(String(t))).length;
  }

  console.log(APPLY ? 'APPLYING cleanup\n' : 'DRY RUN — nothing will be changed (pass --apply to delete)\n');
  console.log(`Orphaned notifications: ${orphaned.length} (${orphaned.filter((n) => !n.isRead).length} unread)`);
  Object.entries(byType)
    .sort((a, b) => b[1] - a[1])
    .forEach(([type, count]) => console.log(`  ${type.padEnd(24)} ${count}`));
  console.log(`Personal List entries pointing at deleted/archived tasks: ${deadPersonal}`);
  console.log(`\nKept: deletion audit notices, and team/department notifications stored as 'Project'.`);

  if (APPLY) {
    const res = await db
      .collection('notifications')
      .deleteMany({ _id: { $in: orphaned.map((n) => n._id) } });
    let pulled = 0;
    for (const u of usersWithDeadItems) {
      const dead = (u.preferences.personalList || []).filter((t) => !liveTasks.has(String(t)));
      if (!dead.length) continue;
      await db
        .collection('users')
        .updateOne({ _id: u._id }, { $pull: { 'preferences.personalList': { $in: dead } } });
      pulled += dead.length;
    }
    console.log(`\nDeleted ${res.deletedCount} notifications, removed ${pulled} Personal List entries.`);
  }

  await mongoose.disconnect();
})().catch((err) => {
  console.error('Cleanup failed:', err.message);
  process.exit(1);
});
