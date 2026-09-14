const NOTIFICATION_TYPES = Object.freeze({
  TASK_ASSIGNED: 'task_assigned',
  TASK_CREATED: 'task_created',
  TASK_STATUS_CHANGED: 'task_status_changed',
  TASK_DUE_SOON: 'task_due_soon',
  TASK_PENDING_APPROVAL: 'task_pending_approval',
  TASK_APPROVED: 'task_approved',
  TASK_REJECTED: 'task_rejected',
  TASK_DELETED: 'task_deleted',
  COMMENT_ADDED: 'comment_added',
  MENTIONED: 'mentioned',
  PROJECT_INVITE: 'project_invite',
  PROJECT_CREATED: 'project_created',
  PROJECT_MEMBER_ADDED: 'project_member_added',
  PROJECT_UPDATED: 'project_updated',
  PROJECT_DELETED: 'project_deleted',
  USER_INVITED: 'user_invited',
  USER_DELETED: 'user_deleted',
  USER_DEACTIVATED: 'user_deactivated',
  DEPARTMENT_CREATED: 'department_created',
  TEAM_CREATED: 'team_created',
  MEETING_SCHEDULED: 'meeting_scheduled',
  MESSAGE_RECEIVED: 'message_received',
});

/** Audience: personal → associated users; system → Superadmin only */
const NOTIFICATION_SCOPES = Object.freeze({
  PERSONAL: 'personal',
  SYSTEM: 'system',
});

/** Types that are always Superadmin-only (admin ops — never shown to members) */
const SYSTEM_ONLY_TYPES = Object.freeze([
  NOTIFICATION_TYPES.TASK_DELETED,
  NOTIFICATION_TYPES.PROJECT_DELETED,
  NOTIFICATION_TYPES.USER_DELETED,
  NOTIFICATION_TYPES.USER_DEACTIVATED,
]);

/**
 * What a notification or activity entry is *about*. entityType must describe the
 * entity entityId points at — the inbox, deletion cleanup and audit log all route
 * and match on it. Team and Department were missing, so team/department events
 * were stored as 'Project' with a team or department id, which sent clicks to a
 * "project not found" page and made the ids unsafe to match on.
 */
const ENTITY_TYPES = Object.freeze([
  'Task',
  'Project',
  'Team',
  'Department',
  'Comment',
  'Meeting',
  'User',
  'System',
]);

module.exports = {
  NOTIFICATION_TYPES,
  NOTIFICATION_TYPE_VALUES: Object.values(NOTIFICATION_TYPES),
  NOTIFICATION_SCOPES,
  SYSTEM_ONLY_TYPES,
  ENTITY_TYPES,
};
