const TASK_STATUS = Object.freeze({
  BACKLOG: 'backlog',
  TODO: 'todo',
  IN_PROGRESS: 'in_progress',
  IN_REVIEW: 'in_review',
  DONE: 'done',
});

const TASK_PRIORITY = Object.freeze({
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  URGENT: 'urgent',
});

/** Max developers that can be assigned to one task at a time. */
const MAX_TASK_ASSIGNEES = 3;

module.exports = {
  TASK_STATUS,
  TASK_STATUS_VALUES: Object.values(TASK_STATUS),
  TASK_PRIORITY,
  TASK_PRIORITY_VALUES: Object.values(TASK_PRIORITY),
  MAX_TASK_ASSIGNEES,
};
