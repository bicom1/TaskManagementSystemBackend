const NOTIFICATION_TYPES = Object.freeze({
  TASK_ASSIGNED: 'task_assigned',
  TASK_STATUS_CHANGED: 'task_status_changed',
  TASK_DUE_SOON: 'task_due_soon',
  TASK_PENDING_APPROVAL: 'task_pending_approval',
  TASK_APPROVED: 'task_approved',
  TASK_REJECTED: 'task_rejected',
  COMMENT_ADDED: 'comment_added',
  MENTIONED: 'mentioned',
  PROJECT_INVITE: 'project_invite',
  USER_INVITED: 'user_invited',
  DEPARTMENT_CREATED: 'department_created',
  TEAM_CREATED: 'team_created',
  MESSAGE_RECEIVED: 'message_received',
});

module.exports = {
  NOTIFICATION_TYPES,
  NOTIFICATION_TYPE_VALUES: Object.values(NOTIFICATION_TYPES),
};
