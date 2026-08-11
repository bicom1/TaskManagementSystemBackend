const { TASK_STATUS } = require('../constants/task.constant');

const FLOW = [
  TASK_STATUS.BACKLOG,
  TASK_STATUS.TODO,
  TASK_STATUS.IN_PROGRESS,
  TASK_STATUS.IN_REVIEW,
  TASK_STATUS.DONE,
];

function statusIndex(status) {
  const i = FLOW.indexOf(status);
  return i < 0 ? 0 : i;
}

function nextInFlow(status) {
  const i = statusIndex(status);
  if (i >= FLOW.length - 1) return status;
  return FLOW[i + 1];
}

function checklistComplete(checklist = []) {
  if (!Array.isArray(checklist) || checklist.length === 0) return false;
  return checklist.every((item) => item.isDone);
}

function checklistHasProgress(checklist = []) {
  return (checklist || []).some((item) => item.isDone);
}

/**
 * Decide automatic status from workflow events.
 * Never moves backwards. Respects explicit status in updates when provided.
 */
function resolveAutoStatus(existing, updates = {}, event = 'update') {
  if (updates.status) {
    return updates.status;
  }

  let status = existing.status || TASK_STATUS.BACKLOG;
  const nextAssignees = updates.assignees ?? existing.assignees ?? [];
  const assigneeCount = Array.isArray(nextAssignees) ? nextAssignees.length : 0;
  const checklist = updates.checklist ?? existing.checklist ?? [];

  // 1) Assigned → Todo
  if (assigneeCount > 0 && status === TASK_STATUS.BACKLOG) {
    status = TASK_STATUS.TODO;
  }

  // 2) Work started (checklist progress, hours, description edit, comment) → In Progress
  const workStarted =
    event === 'work_started' ||
    event === 'comment' ||
    (typeof updates.loggedHours === 'number' &&
      updates.loggedHours > (existing.loggedHours || 0)) ||
    (updates.description !== undefined &&
      updates.description !== existing.description &&
      assigneeCount > 0) ||
    checklistHasProgress(checklist);

  if (workStarted && (status === TASK_STATUS.TODO || status === TASK_STATUS.BACKLOG)) {
    status = TASK_STATUS.IN_PROGRESS;
  }

  // 3) All checklist items done → In Review
  if (checklistComplete(checklist) && status === TASK_STATUS.IN_PROGRESS) {
    status = TASK_STATUS.IN_REVIEW;
  }

  // 4) Explicit advance one step
  if (event === 'advance') {
    status = nextInFlow(existing.status);
  }

  // 5) Approved while in review → Done (optional completion)
  if (event === 'approved' && existing.status === TASK_STATUS.IN_REVIEW) {
    status = TASK_STATUS.DONE;
  }

  // Never regress
  if (statusIndex(status) < statusIndex(existing.status)) {
    return existing.status;
  }

  return status;
}

module.exports = {
  FLOW,
  STATUS_FLOW: FLOW,
  nextInFlow,
  resolveAutoStatus,
  checklistComplete,
  statusIndex,
};
