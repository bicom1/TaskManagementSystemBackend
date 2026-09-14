const Task = require('../models/task.model');
const Notification = require('../models/notification.model');
const Comment = require('../models/comment.model');
const Conversation = require('../models/conversation.model');
const Meeting = require('../models/meeting.model');
const User = require('../models/user.model');
const { NOTIFICATION_TYPES } = require('../constants/notification.constant');

/**
 * Removes everything that points at a deleted task or project.
 *
 * Deleting a project used to archive its tasks and drop the project, but left
 * every notification about those tasks behind — so the inbox kept listing work
 * from projects that no longer existed and the unread badge counted it.
 * Single-task deletion had the same gap, plus orphaned subtasks and comments.
 *
 * Matching is always by the exact ids being deleted. Never sweep by "entity no
 * longer exists": team and department notifications were historically stored
 * with entityType 'Project' (corrected by scripts/migrate-entity-types.js), and a
 * sweep like that would wipe any row the migration did not reach.
 */

/** Deletion notices are the audit trail — they are about the thing being gone. */
const AUDIT_TYPES = [
  NOTIFICATION_TYPES.TASK_DELETED,
  NOTIFICATION_TYPES.PROJECT_DELETED,
  NOTIFICATION_TYPES.USER_DELETED,
];

/** A task plus every subtask beneath it, at any depth. */
async function collectTaskSubtree(rootId) {
  const ids = [String(rootId)];
  let frontier = [rootId];
  while (frontier.length) {
    const children = await Task.find({ parentTask: { $in: frontier } })
      .select('_id')
      .lean();
    frontier = children.map((c) => c._id).filter((cid) => !ids.includes(String(cid)));
    ids.push(...frontier.map(String));
  }
  return ids;
}

/**
 * @param {Array} taskIds
 * @param {{ deleteComments?: boolean }} options
 *   deleteComments — true when the tasks are hard-deleted. When a project is
 *   deleted its tasks are archived instead, so their comments are left in place.
 */
async function cleanupTaskReferences(taskIds, { deleteComments = false } = {}) {
  if (!taskIds?.length) return;

  await Promise.all([
    Notification.deleteMany({
      entityType: 'Task',
      entityId: { $in: taskIds },
      type: { $nin: AUDIT_TYPES },
    }),
    deleteComments ? Comment.deleteMany({ task: { $in: taskIds } }) : null,
    Conversation.updateMany({ relatedTask: { $in: taskIds } }, { isActive: false }),
    User.updateMany(
      { 'preferences.personalList': { $in: taskIds } },
      { $pull: { 'preferences.personalList': { $in: taskIds } } }
    ),
    Task.updateMany(
      { $or: [{ blockedBy: { $in: taskIds } }, { relatedTasks: { $in: taskIds } }] },
      { $pull: { blockedBy: { $in: taskIds }, relatedTasks: { $in: taskIds } } }
    ),
  ]);
}

async function cleanupProjectReferences(projectId) {
  await Promise.all([
    Notification.deleteMany({
      entityType: 'Project',
      entityId: projectId,
      type: { $nin: AUDIT_TYPES },
    }),
    Conversation.updateMany({ relatedProject: projectId }, { isActive: false }),
    // Keep the meeting — it still happened — but drop the dead project link.
    Meeting.updateMany({ project: projectId }, { project: null }),
  ]);
}

module.exports = {
  AUDIT_TYPES,
  collectTaskSubtree,
  cleanupTaskReferences,
  cleanupProjectReferences,
};
