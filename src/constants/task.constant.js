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

module.exports = {
  TASK_STATUS,
  TASK_STATUS_VALUES: Object.values(TASK_STATUS),
  TASK_PRIORITY,
  TASK_PRIORITY_VALUES: Object.values(TASK_PRIORITY),
};
