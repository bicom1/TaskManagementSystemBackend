const taskRepository = require('../repositories/task.repository');
const projectRepository = require('../repositories/project.repository');
const teamRepository = require('../repositories/team.repository');
const activityService = require('./activity.service');
const notificationService = require('./notification.service');
const policy = require('./policy.service');
const ApiError = require('../utils/ApiError.util');
const { NOTIFICATION_TYPES } = require('../constants/notification.constant');
const { canApproveTasks, isLeadOrAbove, ROLES } = require('../constants/roles.constant');
const { PERMISSIONS, ACCESS } = require('../constants/permissions.constant');
const Task = require('../models/task.model');
const { APPROVAL_STATUS } = Task;
const { resolveAutoStatus, nextInFlow } = require('./taskProgression.util');
const { TASK_STATUS } = require('../constants/task.constant');
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

    const projectAccess = policy.getProjectAccess(actor, project);
    // SEO Head (and other dept heads): full manage in own dept; in other depts may create/assign/edit but not delete
    // (delete still requires MANAGE — see delete())

    const actorId = actor.id;
    const actorRole = actor.role;

    const sequence = await projectRepository.getNextTaskSequence(data.project);
    const key = `${project.key}-${sequence}`;

    const position = data.status
      ? (await taskRepository.getMaxPositionInColumn(data.project, data.status)) + 1
      : 1;

    const autoApprove = isLeadOrAbove(actorRole) && projectAccess === ACCESS.MANAGE;
    const approvalStatus = autoApprove ? APPROVAL_STATUS.APPROVED : APPROVAL_STATUS.PENDING;

    let initialStatus = data.status || 'backlog';
    if (!data.status && data.assignees?.length) {
      initialStatus = TASK_STATUS.TODO;
    }

    // Any authenticated user who can create in this project may assign teammates.
    // Super Admin is always notified (see notifySuperAdmins below).

    const task = await taskRepository.create({
      ...data,
      status: initialStatus,
      key,
      position,
      reporter: actorId,
      approvalStatus,
      approvedBy: autoApprove ? actorId : null,
      approvedAt: autoApprove ? new Date() : null,
    });

    const populated = await taskRepository.findById(task._id, {
      populate: [
        { path: 'assignees', select: 'name avatarUrl email jobTitle role' },
        { path: 'reporter', select: 'name avatarUrl' },
      ],
    });

    await activityService.record({
      actor: actorId,
      action: 'created',
      entityType: 'Task',
      entityId: task._id,
      metadata: { approvalStatus },
    });

    if (!autoApprove) {
      const team = await teamRepository.findById(project.team?._id || project.team);
      if (team?.lead) {
        await notificationService.notify({
          recipient: team.lead,
          sender: actorId,
          type: NOTIFICATION_TYPES.TASK_PENDING_APPROVAL,
          message: `Task "${task.title}" needs your approval before work can start`,
          entityType: 'Task',
          entityId: task._id,
          emailToo: true,
          metadata: { projectId: String(data.project) },
          emailSubject: `Approval needed: ${task.title}`,
        });
      }
    }

    if (data.assignees?.length) {
      await this.#notifyAssignees(populated || task, actorId, data.project);
    }

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

    // ClickUp-style: anyone who can open the Space/Project sees the full board
    for (const task of tasks) {
      if (columns[task.status]) columns[task.status].push(task);
    }
    return columns;
  }

  async getById(id, actorInput) {
    const actor = await resolveActor(actorInput);
    const task = await taskRepository.findById(id, {
      populate: [
        { path: 'assignees', select: 'name avatarUrl email jobTitle role' },
        { path: 'reporter', select: 'name avatarUrl jobTitle role' },
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
    return task;
  }

  async getSubtasks(parentTaskId, actorInput) {
    await this.getById(parentTaskId, actorInput);
    return taskRepository.findSubtasks(parentTaskId);
  }

  async getPendingApprovals(actorInput) {
    const actor = await resolveActor(actorInput);
    if (!policy.hasPermission(actor, PERMISSIONS.TASK_APPROVE)) {
      throw ApiError.forbidden('You cannot approve tasks');
    }

    let teamIds = actor.ledTeamIds || [];

    // Dept heads: all teams in managed departments
    if (actor.role === ROLES.DEPT_HEAD && (actor.headedDepartmentIds || []).length) {
      const teams = await teamRepository.findPaginated(
        { department: { $in: actor.headedDepartmentIds }, isActive: true },
        { page: 1, limit: 200 }
      );
      teamIds = (teams.data || []).map((t) => String(t._id));
    }

    if (actor.role === ROLES.SUPER_ADMIN) {
      const teams = await teamRepository.findPaginated(
        { isActive: true },
        { page: 1, limit: 500 }
      );
      teamIds = (teams.data || []).map((t) => String(t._id));
    }

    if (!teamIds.length) return [];

    const projects = await projectRepository.findPaginated(
      { team: { $in: teamIds } },
      { page: 1, limit: 500 }
    );
    const projectIds = (projects.data || []).map((p) => p._id);
    if (!projectIds.length) return [];

    return Task.find({
      project: { $in: projectIds },
      approvalStatus: APPROVAL_STATUS.PENDING,
      isArchived: false,
    })
      .populate('reporter', 'name avatarUrl')
      .populate('project', 'name key')
      .sort({ createdAt: -1 })
      .lean();
  }

  async #assertCanApprove(actor, task) {
    if (!policy.hasPermission(actor, PERMISSIONS.TASK_APPROVE) && !canApproveTasks(actor.role)) {
      throw ApiError.forbidden('Only team leads and above can approve tasks');
    }
    const project = await loadProjectScoped(task.project?._id || task.project);
    if (!project) throw ApiError.notFound('Project not found');
    const access = policy.getProjectAccess(actor, project);
    if (access !== ACCESS.MANAGE) {
      throw ApiError.forbidden('You can only approve tasks in teams you manage');
    }
    return project;
  }

  async approve(id, actorInput) {
    const actor = await resolveActor(actorInput);
    const existing = await taskRepository.findById(id);
    if (!existing) throw ApiError.notFound('Task not found');
    await this.#assertCanApprove(actor, existing);

    if (existing.approvalStatus === APPROVAL_STATUS.APPROVED) {
      return existing;
    }

    const task = await taskRepository.updateById(id, {
      approvalStatus: APPROVAL_STATUS.APPROVED,
      approvedBy: actor.id,
      approvedAt: new Date(),
      rejectionReason: null,
      status:
        existing.status === TASK_STATUS.IN_REVIEW
          ? TASK_STATUS.DONE
          : existing.status === TASK_STATUS.BACKLOG
            ? TASK_STATUS.TODO
            : existing.status,
    });

    await activityService.record({
      actor: actor.id,
      action: 'approved',
      entityType: 'Task',
      entityId: id,
    });

    await notificationService.notify({
      recipient: existing.reporter,
      sender: actor.id,
      type: NOTIFICATION_TYPES.TASK_APPROVED,
      message: `Your task "${existing.title}" was approved`,
      entityType: 'Task',
      entityId: id,
      emailToo: true,
      metadata: { projectId: String(existing.project?._id || existing.project || '') },
      emailSubject: `Task approved: ${existing.title}`,
    });

    if (task.assignees?.length) {
      await this.#notifyAssignees(
        task,
        actor.id,
        existing.project?._id || existing.project
      );
    }

    emitTaskEvent('task:updated', task, existing.project);
    return task;
  }

  async reject(id, actorInput, reason) {
    const actor = await resolveActor(actorInput);
    const existing = await taskRepository.findById(id);
    if (!existing) throw ApiError.notFound('Task not found');
    await this.#assertCanApprove(actor, existing);

    const task = await taskRepository.updateById(id, {
      approvalStatus: APPROVAL_STATUS.REJECTED,
      approvedBy: actor.id,
      approvedAt: new Date(),
      rejectionReason: reason || 'Rejected by team lead',
    });

    await activityService.record({
      actor: actor.id,
      action: 'rejected',
      entityType: 'Task',
      entityId: id,
      metadata: { reason },
    });

    await notificationService.notify({
      recipient: existing.reporter,
      sender: actor.id,
      type: NOTIFICATION_TYPES.TASK_REJECTED,
      message: `Your task "${existing.title}" was rejected${reason ? `: ${reason}` : ''}`,
      entityType: 'Task',
      entityId: id,
      emailToo: true,
      metadata: { projectId: String(existing.project?._id || existing.project || '') },
      emailSubject: `Task rejected: ${existing.title}`,
    });

    emitTaskEvent('task:updated', task, existing.project);
    return task;
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

    if (
      existing.approvalStatus === APPROVAL_STATUS.PENDING &&
      updates.status &&
      updates.status !== 'backlog' &&
      !canApproveTasks(actor.role)
    ) {
      throw ApiError.forbidden('Task must be approved by a team lead before status changes');
    }

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
      if (
        existing.approvalStatus === APPROVAL_STATUS.PENDING &&
        !canApproveTasks(actor.role)
      ) {
        throw ApiError.forbidden('Task must be approved before advancing workflow');
      }
      updates.status = nextInFlow(existing.status);
    }

    const previousAssigneeIds = (existing.assignees || []).map((a) => String(a._id || a));

    if (!updates.status) {
      const autoStatus = resolveAutoStatus(existing, updates, 'update');
      if (autoStatus && autoStatus !== existing.status) {
        if (
          existing.approvalStatus === APPROVAL_STATUS.APPROVED ||
          canApproveTasks(actor.role) ||
          autoStatus === TASK_STATUS.TODO ||
          autoStatus === TASK_STATUS.IN_PROGRESS ||
          autoStatus === TASK_STATUS.IN_REVIEW
        ) {
          if (
            existing.approvalStatus === APPROVAL_STATUS.PENDING &&
            ![TASK_STATUS.BACKLOG, TASK_STATUS.TODO].includes(autoStatus) &&
            !canApproveTasks(actor.role)
          ) {
            // keep waiting
          } else {
            updates.status = autoStatus;
          }
        }
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

      await Promise.all(
        (task.assignees || [])
          .filter((a) => String(a._id || a) !== String(actorId))
          .map((assigneeId) =>
            notificationService.notify({
              recipient: assigneeId._id || assigneeId,
              sender: actorId,
              type: NOTIFICATION_TYPES.TASK_STATUS_CHANGED,
              message: `"${task.title}" moved to ${String(updates.status).replace(/_/g, ' ')}`,
              entityType: 'Task',
              entityId: id,
            })
          )
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

    if (
      existing.approvalStatus === APPROVAL_STATUS.PENDING &&
      !canApproveTasks(actor.role)
    ) {
      throw ApiError.forbidden('Task must be approved before advancing workflow');
    }

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

    if (
      existing.approvalStatus === APPROVAL_STATUS.PENDING &&
      ![TASK_STATUS.BACKLOG, TASK_STATUS.TODO].includes(nextStatus)
    ) {
      return existing;
    }

    return taskRepository.updateById(taskId, { status: nextStatus });
  }

  async moveToColumn(id, { status, position }, actorInput) {
    const actor = await resolveActor(actorInput);
    const existing = await taskRepository.findById(id, {
      populate: [{ path: 'project', populate: { path: 'team', select: 'lead members department' } }],
    });
    if (!existing) throw ApiError.notFound('Task not found');
    policy.assertTaskManage(actor, existing, existing.project);

    if (
      existing.approvalStatus !== APPROVAL_STATUS.APPROVED &&
      status !== 'backlog' &&
      !canApproveTasks(actor.role)
    ) {
      throw ApiError.forbidden('Pending tasks cannot move until a team lead approves them');
    }

    if (
      existing.approvalStatus === APPROVAL_STATUS.REJECTED &&
      !canApproveTasks(actor.role)
    ) {
      throw ApiError.forbidden('Rejected tasks cannot be moved');
    }

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
    policy.assertPermission(actor, PERMISSIONS.TASK_DELETE);

    const existing = await taskRepository.findById(id, {
      populate: [{ path: 'project', populate: { path: 'team', select: 'lead members department' } }],
    });
    if (!existing) throw ApiError.notFound('Task not found');

    const access = policy.getProjectAccess(actor, existing.project);
    // Super Admin: delete anywhere. Dept heads / leads: only where they MANAGE (own dept/team).
    // SEO Head may edit Dev/Designing but cannot delete there (VIEW ≠ MANAGE).
    if (access !== ACCESS.MANAGE && actor.role !== ROLES.SUPER_ADMIN) {
      throw ApiError.forbidden(
        'You can only delete tasks in departments/projects you manage. Cross-department work is view/edit only.'
      );
    }

    const task = await taskRepository.deleteById(id);
    if (!task) throw ApiError.notFound('Task not found');
    emitTaskEvent('task:deleted', task, existing.project?._id || existing.project);
    return task;
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
