const projectRepository = require('../repositories/project.repository');
const teamRepository = require('../repositories/team.repository');
const policy = require('./policy.service');
const ApiError = require('../utils/ApiError.util');
const { invalidateByPrefix } = require('../config/redis');
const { PERMISSIONS, ACCESS } = require('../constants/permissions.constant');
const { ROLES } = require('../constants/roles.constant');
const {
  getWorkflowTemplate,
  generateProjectKey,
} = require('../constants/space.constant');
const { emitProjectEvent } = require('../socket/socket');
const Conversation = require('../models/conversation.model');
const notificationService = require('./notification.service');
const { NOTIFICATION_TYPES } = require('../constants/notification.constant');

async function resolveActor(actor) {
  if (actor?.context) return actor.context;
  if (actor?.permissions && actor?.teamIds) return actor;
  return policy.buildActorContext(actor.id);
}

async function resolveUniqueKey(preferred) {
  let base = (preferred || 'SP').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || 'SP';
  let candidate = base;
  let n = 1;
  while (await projectRepository.existsByKey(candidate)) {
    const suffix = String(n++);
    candidate = `${base.slice(0, Math.max(1, 10 - suffix.length))}${suffix}`;
    if (n > 99) {
      candidate = `S${Date.now().toString(36).toUpperCase().slice(-5)}`;
      break;
    }
  }
  return candidate;
}

async function resolveTeamForCreate(actor, teamId) {
  if (teamId) {
    const team = await teamRepository.findById(teamId);
    if (!team) throw ApiError.notFound('Team not found');
    const teamAccess = policy.getTeamAccess(actor, team);
    // Any org member with view/manage on the team can create a project there
    if (teamAccess === ACCESS.NONE) {
      throw ApiError.forbidden('You can only create projects for teams you belong to');
    }
    return team;
  }

  const teams = await teamRepository.findPaginated(
    {
      $or: [{ lead: actor.id }, { members: actor.id }],
    },
    { page: 1, limit: 50 }
  );

  const list = teams.data || [];

  for (const team of list) {
    if (policy.getTeamAccess(actor, team) === ACCESS.MANAGE) {
      return team;
    }
  }

  for (const team of list) {
    if (policy.getTeamAccess(actor, team) !== ACCESS.NONE) {
      return team;
    }
  }

  if (list.length) {
    return list[0];
  }

  // Super admin / dept head with no membership: use any active team
  if (actor.role === ROLES.SUPER_ADMIN || actor.role === ROLES.DEPT_HEAD) {
    const any = await teamRepository.findPaginated(
      { isActive: { $ne: false } },
      { page: 1, limit: 1 }
    );
    if (any.data?.[0]) return any.data[0];
  }

  throw ApiError.badRequest(
    'Join a team first — projects are attached to a team you belong to'
  );
}

class ProjectService {
  async create(data, actorInput) {
    const actor = await resolveActor(actorInput);
    policy.assertPermission(actor, PERMISSIONS.PROJECT_CREATE);

    const team = await resolveTeamForCreate(actor, data.team);
    // Reload with members so every teammate gets the new project (ClickUp-style)
    const teamDoc = await teamRepository.findById(team._id, {
      populate: [{ path: 'members', select: '_id' }, { path: 'lead', select: '_id' }],
    });
    const template = getWorkflowTemplate(data.workflowTemplate || 'starter');

    const preferredKey = data.key || generateProjectKey(data.name);
    const key = await resolveUniqueKey(preferredKey);

    const teamMemberIds = [
      String(teamDoc?.lead?._id || teamDoc?.lead || team.lead || ''),
      ...((teamDoc?.members || team.members || []).map((m) => String(m._id || m))),
      ...(data.members || []).map(String),
      String(data.owner || actor.id),
    ].filter(Boolean);

    const payload = {
      name: data.name,
      key,
      description: data.description || '',
      team: team._id,
      owner: data.owner || actor.id,
      members: [...new Set(teamMemberIds)],
      status: 'active',
      startDate: data.startDate,
      endDate: data.endDate,
      icon: data.icon ?? (data.name?.[0]?.toUpperCase() || 'S'),
      color: data.color || '#292524',
      isPrivate: Boolean(data.isPrivate),
      defaultPermission: data.defaultPermission || 'full_edit',
      workflowTemplate: template.id,
      kind: data.kind || 'project',
      statuses: data.statuses?.length
        ? data.statuses
        : template.statuses.map((s) => ({ ...s })),
      defaultViews: data.defaultViews?.length
        ? data.defaultViews
        : [...template.defaultViews],
      clickApps: data.clickApps?.length ? data.clickApps : [...template.clickApps],
      activeView: data.activeView || template.defaultViews[0] || 'list',
    };

    const project = await projectRepository.create(payload);

    emitProjectEvent('project:created', project, {
      teamId: team._id,
      ownerId: payload.owner,
      memberIds: payload.members,
    });

    await this.#notifyProjectMembers({
      project,
      actorId: actor.id,
      type: NOTIFICATION_TYPES.PROJECT_CREATED,
      message: `You were added to project "${project.name}"`,
      emailSubject: `New project: ${project.name}`,
    });

    return project;
  }

  async list(actorInput, { page, limit, team, status }) {
    const actor = await resolveActor(actorInput);
    policy.assertPermission(actor, PERMISSIONS.PROJECT_VIEW);

    const scopeFilter = await policy.projectListFilter(actor);
    const filter = {
      ...scopeFilter,
      ...(team && { team }),
      ...(status && { status }),
    };

    const result = await projectRepository.findPaginated(filter, {
      page,
      limit,
      populate: [
        { path: 'owner', select: 'name avatarUrl' },
        { path: 'team', select: 'name department', populate: { path: 'department', select: 'name code' } },
      ],
    });

    const Task = require('../models/task.model');
    const ids = (result.data || []).map((p) => p._id).filter(Boolean);
    const countMap = new Map();
    if (ids.length) {
      const counts = await Task.aggregate([
        {
          $match: {
            project: { $in: ids },
            isArchived: { $ne: true },
            status: { $ne: 'done' },
          },
        },
        { $group: { _id: '$project', count: { $sum: 1 } } },
      ]);
      for (const row of counts) {
        countMap.set(String(row._id), row.count);
      }
    }

    result.data = (result.data || []).map((p) => {
      const obj = p.toObject ? p.toObject() : { ...p };
      obj.openTaskCount = countMap.get(String(obj._id)) || 0;
      obj.canManage = policy.getProjectAccess(actor, p) === ACCESS.MANAGE;
      return obj;
    });

    return result;
  }

  async getById(id, actorInput) {
    const actor = await resolveActor(actorInput);
    const project = await projectRepository.findById(id, {
      populate: [
        { path: 'owner', select: 'name avatarUrl email jobTitle' },
        { path: 'members', select: 'name avatarUrl email jobTitle' },
        {
          path: 'team',
          select: 'name lead members department',
          populate: [
            { path: 'lead', select: 'name avatarUrl email jobTitle' },
            { path: 'members', select: 'name avatarUrl email jobTitle' },
            { path: 'department', select: 'name code' },
          ],
        },
      ],
    });
    if (!project) throw ApiError.notFound('Project not found');
    policy.assertProjectView(actor, project);

    const access = policy.getProjectAccess(actor, project);
    const obj = project.toObject ? project.toObject() : project;
    return { ...obj, accessMode: access, canManage: access === ACCESS.MANAGE };
  }

  async update(id, updates, actorInput) {
    const actor = await resolveActor(actorInput);
    policy.assertPermission(actor, PERMISSIONS.PROJECT_EDIT);

    const existing = await projectRepository.findById(id, {
      populate: [{ path: 'team', select: 'lead members department' }],
    });
    if (!existing) throw ApiError.notFound('Project not found');
    policy.assertProjectManage(actor, existing);

    if (updates.workflowTemplate && !updates.statuses) {
      const template = getWorkflowTemplate(updates.workflowTemplate);
      updates.statuses = template.statuses.map((s) => ({ ...s }));
      if (!updates.defaultViews) updates.defaultViews = [...template.defaultViews];
      if (!updates.clickApps) updates.clickApps = [...template.clickApps];
    }

    const project = await projectRepository.updateById(id, updates);
    if (!project) throw ApiError.notFound('Project not found');
    await invalidateByPrefix(`project:${id}`);

    emitProjectEvent('project:updated', project, {
      teamId: existing.team?._id || existing.team,
      ownerId: project.owner,
      memberIds: project.members,
    });

    return project;
  }

  async addMember(projectId, userId, actorInput) {
    const actor = await resolveActor(actorInput);
    const existing = await projectRepository.findById(projectId, {
      populate: [{ path: 'team', select: 'lead members department' }],
    });
    if (!existing) throw ApiError.notFound('Project not found');
    policy.assertProjectManage(actor, existing);

    const project = await projectRepository.updateById(projectId, {
      $addToSet: { members: userId },
    });
    if (!project) throw ApiError.notFound('Project not found');

    emitProjectEvent('project:updated', project, {
      teamId: existing.team?._id || existing.team,
      ownerId: project.owner,
      memberIds: project.members,
    });

    await Conversation.updateOne(
      { type: 'project', relatedProject: projectId, isActive: true },
      { $addToSet: { participants: userId }, $unset: { dmKey: 1 } }
    );

    if (String(userId) !== String(actor.id)) {
      await notificationService
        .notify({
          recipient: userId,
          sender: actor.id,
          type: NOTIFICATION_TYPES.PROJECT_MEMBER_ADDED,
          message: `You were added to project "${existing.name}"`,
          entityType: 'Project',
          entityId: projectId,
          emailToo: true,
          emailSubject: `Added to project: ${existing.name}`,
        })
        .catch(() => {});
    }

    return project;
  }

  async delete(id, actorInput) {
    const actor = await resolveActor(actorInput);
    policy.assertPermission(actor, PERMISSIONS.PROJECT_EDIT);

    const existing = await projectRepository.findById(id, {
      populate: [{ path: 'team', select: 'lead members department' }],
    });
    if (!existing) throw ApiError.notFound('Project not found');
    policy.assertProjectManage(actor, existing);

    const Task = require('../models/task.model');
    await Task.updateMany({ project: id }, { isArchived: true });
    await Conversation.updateMany({ relatedProject: id }, { isActive: false });
    await projectRepository.deleteById(id);
    await invalidateByPrefix(`project:${id}`);

    emitProjectEvent(
      'project:deleted',
      { _id: id, name: existing.name },
      {
        teamId: existing.team?._id || existing.team,
        ownerId: existing.owner,
        memberIds: existing.members,
      }
    );

    return { id, name: existing.name };
  }

  async #notifyProjectMembers({ project, actorId, type, message, emailSubject }) {
    const actorKey = String(actorId);
    const memberIds = [...new Set((project.members || []).map((m) => String(m._id || m)))].filter(
      Boolean
    );

    await Promise.all(
      memberIds
        .filter((memberId) => memberId !== actorKey)
        .map((memberId) =>
          notificationService
            .notify({
              recipient: memberId,
              sender: actorId,
              type,
              message,
              entityType: 'Project',
              entityId: project._id,
              emailToo: true,
              emailSubject,
            })
            .catch(() => {})
        )
    );
  }
}

module.exports = new ProjectService();
