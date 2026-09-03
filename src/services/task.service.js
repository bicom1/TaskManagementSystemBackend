const taskRepository = require('../repositories/task.repository');
const projectRepository = require('../repositories/project.repository');
const activityService = require('./activity.service');
const notificationService = require('./notification.service');
const policy = require('./policy.service');
const ApiError = require('../utils/ApiError.util');
const { NOTIFICATION_TYPES } = require('../constants/notification.constant');
const { PERMISSIONS, ACCESS } = require('../constants/permissions.constant');
const Task = require('../models/task.model');
const { APPROVAL_STATUS } = Task;
const { resolveAutoStatus, nextInFlow } = require('./taskProgression.util');
const { TASK_STATUS, MAX_TASK_ASSIGNEES } = require('../constants/task.constant');
const { emitTaskEvent } = require('../socket/socket');
const { notifySuperAdmins } = require('./notifySuperAdmins.util');

async function loadProjectScoped(projectId) {
  return projectRepository.findById(projectId, {
    populate: [{ path: 'team', select: 'name lead members department' }],
  });
}

async function resolveActor(actor) {
  if (actor?.context) return actor.context;
  if (actor?.permissions && actor?.teamIds) return actor;
  return policy.buildActorContext(actor.id);
}

class TaskService {
  async create(data, actorInput) {
    const actor = await resolveActor(actorInput);
    policy.assertPermission(actor, PERMISSIONS.TASK_CREATE);

    const project = await loadProjectScoped(data.project);
    if (!project) throw ApiError.notFound('Project not found');

    if (!policy.canAssignInProject(actor, project)) {
      throw ApiError.forbidden('You cannot create tasks in this project');
    }

    const actorId = actor.id;

    const sequence = await projectRepository.getNextTaskSequence(data.project);
    const key = `${project.key}-${sequence}`;

    const position = data.status
      ? (await taskRepository.getMaxPositionInColumn(data.project, data.status)) + 1
      : 1;

    const approvalStatus = APPROVAL_STATUS.APPROVED;

    let initialStatus = data.status || 'backlog';
    if (!data.status && data.assignees?.length) {
      initialStatus = TASK_STATUS.TODO;
    }

    // Any authenticated user who can create in this project may assign teammates.
    // Super Admin is always notified (see notifySuperAdmins below).
    if (Array.isArray(data.assignees)) {
      data.assignees = [
        ...new Set(
          data.assignees
            .map((a) => String(a?._id || a))
            .filter((id) => /^[a-f\d]{24}$/i.test(id))
        ),
      ].slice(0, MAX_TASK_ASSIGNEES);
    }

    const task = await taskRepository.create({
      ...data,
      status: initialStatus,
      key,
      position,
      reporter: actorId,
      approvalStatus,
      approvedBy: actorId,
      approvedAt: new Date(),
    });

    const populated = await taskRepository.findById(task._id, {
      populate: [
        { path: 'assignees', select: 'name avatarUrl email jobTitle role' },
        { path: 'reporter', select: 'name avatarUrl' },
        { path: 'parentTask', select: 'title key status' },
      ],
    });

    await activityService.record({
      actor: actorId,
      action: 'created',
      entityType: 'Task',
      entityId: task._id,
      metadata: { approvalStatus },
    });

    if (data.assignees?.length) {
      await this.#notifyAssignees(populated || task, actorId, data.project);
    }

    // Creator always gets an inbox notification (Primary tab) for new tasks
    await notificationService.notify({
      recipient: actorId,
      sender: actorId,
      type: NOTIFICATION_TYPES.TASK_CREATED,
      message: `You created "${task.title}"`,
      entityType: 'Task',
      entityId: task._id,
      metadata: { projectId: String(data.project) },
    });

    await notifySuperAdmins({
      actorId,
      type: NOTIFICATION_TYPES.TASK_CREATED,
      message: `${actor.role === 'super_admin' ? 'A task' : 'New task'} "${task.title}" was created`,
      entityType: 'Task',
      entityId: task._id,
      metadata: { projectId: String(data.project) },
      emailSubject: `New task: ${task.title}`,
    });

    emitTaskEvent('task:created', populated || task, data.project);
    return populated || task;
  }

  async getBoard(projectId, actorInput) {
    const actor = await resolveActor(actorInput);
    const project = await loadProjectScoped(projectId);
    if (!project) throw ApiError.notFound('Project not found');
    policy.assertProjectView(actor, project);

    const tasks = await taskRepository.findByProjectGroupedByStatus(projectId);
    const columns = {
      backlog: [],
      todo: [],
      in_progress: [],
      in_review: [],
      done: [],
    };

    const subtaskCounts = {};
    for (const task of tasks) {
      const parentId = task.parentTask ? String(task.parentTask._id || task.parentTask) : null;
      if (parentId) subtaskCounts[parentId] = (subtaskCounts[parentId] || 0) + 1;
    }

    for (const task of tasks) {
      if (!columns[task.status]) continue;
      const access = policy.getTaskAccess(actor, task, project);
      const obj = task.toObject ? task.toObject() : { ...task };
      const id = String(obj._id);
      columns[task.status].push({
        ...obj,
        accessMode: access,
        canManage: access === ACCESS.MANAGE,
        subtaskCount: subtaskCounts[id] || 0,
      });
    }
    return columns;
  }

  async getById(id, actorInput) {
    const actor = await resolveActor(actorInput);
    const task = await taskRepository.findById(id, {
      populate: [
        { path: 'assignees', select: 'name avatarUrl email jobTitle role' },
        { path: 'reporter', select: 'name avatarUrl jobTitle role' },
        { path: 'parentTask', select: 'title key status' },
        { path: 'approvedBy', select: 'name avatarUrl' },
        { path: 'blockedBy', select: 'key title status' },
        { path: 'relatedTasks', select: 'key title status' },
        { path: 'checklist.createdBy', select: 'name avatarUrl' },
        {
          path: 'project',
          select: 'name key team members owner',
          populate: { path: 'team', select: 'name lead members department' },
        },
      ],
    });
    if (!task) throw ApiError.notFound('Task not found');
    policy.assertTaskView(actor, task, task.project);

    const access = policy.getTaskAccess(actor, task, task.project);
    const obj = task.toObject ? task.toObject() : { ...task };
    return { ...obj, accessMode: access, canManage: access === ACCESS.MANAGE };
  }

  async getSubtasks(parentTaskId, actorInput) {
    await this.getById(parentTaskId, actorInput);
    return taskRepository.findSubtasks(parentTaskId);
  }

  async getPendingApprovals(_actorInput) {
    // Approvals disabled — all users can create and work on tasks immediately.
    return [];
  }

  async #assertCanApprove(_actor, _task) {
    throw ApiError.forbidden('Task approvals are disabled — tasks are active as soon as they are created');
  }

  async approve(id, actorInput) {
    const actor = await resolveActor(actorInput);
    const existing = await taskRepository.findById(id);
    if (!existing) throw ApiError.notFound('Task not found');
    // Approvals removed: ensure task is marked approved for legacy records
    if (existing.approvalStatus === APPROVAL_STATUS.APPROVED) {
      return existing;
    }
    const task = await taskRepository.updateById(id, {
      approvalStatus: APPROVAL_STATUS.APPROVED,
      approvedBy: actor.id,
      approvedAt: new Date(),
      rejectionReason: null,
    });
    emitTaskEvent('task:updated', task, existing.project);
    return task;
  }

  async reject(_id, _actorInput, _reason) {
    throw ApiError.forbidden('Task approvals are disabled');
  }

  async update(id, updates, actorInput) {
    const actor = await resolveActor(actorInput);
    const actorId = actor.id;
    const existing = await taskRepository.findById(id, {
      populate: [{ path: 'project', populate: { path: 'team', select: 'lead members department' } }],
    });
    if (!existing) throw ApiError.notFound('Task not found');

    const project = existing.project;
    policy.assertTaskManage(actor, existing, project);

    if (Array.isArray(updates.checklist)) {
      updates.checklist = updates.checklist.map((item) => {
        const next = {
          text: item.text,
          isDone: Boolean(item.isDone),
          doneAt: item.doneAt ?? null,
          createdBy: item.createdBy?._id || item.createdBy || actorId,
        };
        if (item._id) next._id = item._id;
        if (next.isDone && !next.doneAt) {
          next.doneAt = new Date();
        }
        if (!next.isDone) {
          next.doneAt = null;
        }
        return next;
      });
    }

    if (Array.isArray(updates.blockedBy)) {
      const selfId = String(id);
      updates.blockedBy = updates.blockedBy.filter((tid) => String(tid) !== selfId);
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'dueDate') && updates.dueDate === null) {
      updates.dueDate = null;
    }

    const wantsAdvance = Boolean(updates.advanceWorkflow);
    delete updates.advanceWorkflow;

    if (wantsAdvance && !updates.status) {
      updates.status = nextInFlow(existing.status);
    }

    const previousAssigneeIds = (existing.assignees || []).map((a) => String(a._id || a));

    if (Array.isArray(updates.assignees)) {
      updates.assignees = [
        ...new Set(
          updates.assignees
            .map((a) => String(a?._id || a))
            .filter((id) => /^[a-f\d]{24}$/i.test(id))
        ),
      ].slice(0, MAX_TASK_ASSIGNEES);
    }

    if (!updates.status) {
      const autoStatus = resolveAutoStatus(existing, updates, 'update');
      if (autoStatus && autoStatus !== existing.status) {
        updates.status = autoStatus;
      }
    }

    const task = await taskRepository.updateById(id, updates);

    if (updates.status && updates.status !== existing.status) {
      await activityService.record({
        actor: actorId,
        action: 'status_changed',
        entityType: 'Task',
        entityId: id,
        metadata: { from: existing.status, to: updates.status, automatic: true },
      });

      await this.#notifyTaskStatusChange(
        task,
        actorId,
        existing.project?._id || existing.project,
        updates.status
      );
    }

    if (Array.isArray(updates.assignees)) {
      const nextIds = updates.assignees.map(String);
      const newlyAssigned = nextIds.filter((aid) => !previousAssigneeIds.includes(aid));
      if (newlyAssigned.length) {
        await this.#notifyAssignees(
          {
            ...(task.toObject?.() || task),
            assignees: newlyAssigned,
            title: task.title,
            _id: task._id,
          },
          actorId,
          existing.project?._id || existing.project
        );
      }
      await activityService.record({
        actor: actorId,
        action: 'assigned',
        entityType: 'Task',
        entityId: id,
        metadata: { assignees: nextIds, previous: previousAssigneeIds },
      });

      const assigneesChanged =
        nextIds.length !== previousAssigneeIds.length ||
        nextIds.some((aid) => !previousAssigneeIds.includes(aid));
      if (assigneesChanged) {
        await notifySuperAdmins({
          actorId,
          type: NOTIFICATION_TYPES.TASK_ASSIGNED,
          message: `Task "${task.title}" was reassigned`,
          entityType: 'Task',
          entityId: task._id,
          metadata: { projectId: String(existing.project?._id || existing.project || '') },
          emailSubject: `Task reassigned: ${task.title}`,
        });
      }
    }

    const trackedFields = [
      'title',
      'description',
      'priority',
      'dueDate',
      'labels',
      'checklist',
      'blockedBy',
      'relatedTasks',
      'estimateHours',
      'loggedHours',
      'recurrence',
    ];
    const changed = trackedFields.filter((k) => Object.prototype.hasOwnProperty.call(updates, k));
    if (changed.length) {
      await activityService.record({
        actor: actorId,
        action: 'updated',
        entityType: 'Task',
        entityId: id,
        metadata: { fields: changed },
      });
    }

    const fresh = await this.getById(id, actor);
    emitTaskEvent('task:updated', fresh, project._id || project);
    return fresh;
  }

  async advance(id, actorInput) {
    const actor = await resolveActor(actorInput);
    const existing = await taskRepository.findById(id, {
      populate: [{ path: 'project', populate: { path: 'team', select: 'lead members department' } }],
    });
    if (!existing) throw ApiError.notFound('Task not found');
    policy.assertTaskManage(actor, existing, existing.project);

    const nextStatus = nextInFlow(existing.status);
    if (nextStatus === existing.status) {
      return this.getById(id, actor);
    }

    return this.update(id, { status: nextStatus }, actor);
  }

  async applyCommentProgress(taskId, actorId) {
    const existing = await taskRepository.findById(taskId);
    if (!existing) return null;

    const isAssignee = (existing.assignees || []).some(
      (a) => String(a._id || a) === String(actorId)
    );
    if (!isAssignee) return existing;

    const nextStatus = resolveAutoStatus(existing, {}, 'comment');
    if (nextStatus === existing.status) return existing;

    return taskRepository.updateById(taskId, { status: nextStatus });
  }

  async moveToColumn(id, { status, position }, actorInput) {
    const actor = await resolveActor(actorInput);
    const existing = await taskRepository.findById(id, {
      populate: [{ path: 'project', populate: { path: 'team', select: 'lead members department' } }],
    });
    if (!existing) throw ApiError.notFound('Task not found');
    policy.assertTaskManage(actor, existing, existing.project);

    const task = await taskRepository.updateById(id, { status, position });

    if (status !== existing.status) {
      await activityService.record({
        actor: actor.id,
        action: 'status_changed',
        entityType: 'Task',
        entityId: id,
        metadata: { from: existing.status, to: status },
      });
    }

    emitTaskEvent('task:moved', task, existing.project?._id || existing.project);
    return task;
  }

  async delete(id, actorInput) {
    const actor = await resolveActor(actorInput);
    const existing = await taskRepository.findById(id, {
      populate: [{ path: 'project', populate: { path: 'team', select: 'lead members department' } }],
    });
    if (!existing) throw ApiError.notFound('Task not found');

    policy.assertTaskManage(actor, existing, existing.project);

    const task = await taskRepository.deleteById(id);
    if (!task) throw ApiError.notFound('Task not found');
    emitTaskEvent('task:deleted', task, existing.project?._id || existing.project);
    return task;
  }

  async #notifyTaskStatusChange(task, actorId, projectId, newStatus) {
    const ids = new Set();
    const reporterId = task.reporter?._id || task.reporter;
    if (reporterId) ids.add(String(reporterId));
    (task.assignees || []).forEach((a) => {
      const id = a?._id || a;
      if (id) ids.add(String(id));
    });
    if (actorId) ids.add(String(actorId));

    const statusLabel = String(newStatus).replace(/_/g, ' ');
    const projectKey = projectId ? String(projectId) : '';

    await Promise.all(
      [...ids].map((recipientId) =>
        notificationService
          .notify({
            recipient: recipientId,
            sender: actorId,
            type: NOTIFICATION_TYPES.TASK_STATUS_CHANGED,
            message: `"${task.title}" moved to ${statusLabel}`,
            entityType: 'Task',
            entityId: task._id,
            metadata: { projectId: projectKey },
            emailToo: recipientId !== String(actorId),
            emailSubject: `Task updated: ${task.title}`,
          })
          .catch(() => {})
      )
    );
  }

  async #notifyAssignees(task, actorId, projectIdOverride = null) {
    const actorKey = String(actorId);
    const projectId = String(
      projectIdOverride || task.project?._id || task.project || ''
    );
    const assigneeIds = [...new Set((task.assignees || []).map((a) => String(a._id || a)))].filter(
      Boolean
    );

    await Promise.all(
      assigneeIds
        .filter((assigneeId) => assigneeId !== actorKey)
        .map((assigneeId) =>
          notificationService.notify({
            recipient: assigneeId,
            sender: actorId,
            type: NOTIFICATION_TYPES.TASK_ASSIGNED,
            message: `You were assigned to "${task.title}"`,
            entityType: 'Task',
            entityId: task._id,
            emailToo: true,
            metadata: { projectId },
            emailSubject: `Task assigned: ${task.title}`,
          })
        )
    );
  }
}

module.exports = new TaskService();
