const teamRepository = require('../repositories/team.repository');
const userRepository = require('../repositories/user.repository');
const Project = require('../models/project.model');
require('../models/department.model');
const notificationService = require('./notification.service');
const policy = require('./policy.service');
const ApiError = require('../utils/ApiError.util');
const { NOTIFICATION_TYPES } = require('../constants/notification.constant');
const { ROLES } = require('../constants/roles.constant');
const { PERMISSIONS, ACCESS } = require('../constants/permissions.constant');
const { emitProjectEvent, getIO } = require('../socket/socket');

async function resolveActor(actor) {
  if (actor?.context) return actor.context;
  if (actor?.permissions && actor?.teamIds) return actor;
  if (actor?.id) return policy.buildActorContext(actor.id);
  return actor;
}

class TeamService {
  async create(data, actorInput) {
    const actor = await resolveActor(actorInput);
    policy.assertPermission(actor, PERMISSIONS.TEAM_MANAGE);

    // Only Super Admin and Department Heads create teams
    if (actor.role !== ROLES.SUPER_ADMIN && actor.role !== ROLES.DEPT_HEAD) {
      throw ApiError.forbidden('Only Super Admin or Department Head can create teams');
    }

    if (actor.role !== ROLES.SUPER_ADMIN) {
      policy.assertDepartmentManage(actor, data.department, 'create teams in this department');
    }

    const team = await teamRepository.create(data);

    if (data.lead) {
      await teamRepository.addMember(team._id, data.lead);
      if (data.department) {
        await userRepository.updateById(data.lead, { department: data.department });
      }
    }

    const populated = await teamRepository.findById(team._id, {
      populate: [
        { path: 'lead', select: 'name avatarUrl' },
        { path: 'department', select: 'name code' },
      ],
    });

    const superAdmins = await userRepository.findPaginated(
      { role: ROLES.SUPER_ADMIN, isActive: true },
      { page: 1, limit: 50 }
    );

    const deptLabel = populated.department?.name || 'Department';
    const message = `New team "${populated.name}" created under ${deptLabel}`;

    await Promise.all(
      (superAdmins.data || []).map((admin) =>
        notificationService.notify({
          recipient: admin._id,
          sender: actor.id,
          type: NOTIFICATION_TYPES.TEAM_CREATED,
          message,
          entityType: 'Project',
          entityId: team._id,
          emailToo: true,
        })
      )
    );

    if (data.lead && String(data.lead) !== String(actor.id)) {
      await notificationService.notify({
        recipient: data.lead,
        sender: actor.id,
        type: NOTIFICATION_TYPES.TEAM_CREATED,
        message: `You were assigned as Team Lead of "${populated.name}"`,
        entityType: 'Project',
        entityId: team._id,
        emailToo: true,
      });
    }

    return populated;
  }

  async list(actorInput, { page, limit, department }) {
    const actor = await resolveActor(actorInput);
    policy.assertPermission(actor, PERMISSIONS.TEAM_VIEW);

    const scope = policy.teamListFilter(actor);
    const filter = {
      ...scope,
      ...(department && { department }),
    };

    return teamRepository.findPaginated(filter, {
      page,
      limit,
      populate: [
        { path: 'lead', select: 'name avatarUrl jobTitle role' },
        { path: 'department', select: 'name code' },
        { path: 'members', select: 'name avatarUrl email jobTitle role' },
      ],
    });
  }

  async getById(id, actorInput) {
    const actor = await resolveActor(actorInput);
    const team = await teamRepository.findById(id, {
      populate: [
        { path: 'lead', select: 'name avatarUrl jobTitle role email' },
        { path: 'members', select: 'name avatarUrl email jobTitle role' },
        { path: 'department', select: 'name code' },
      ],
    });
    if (!team) throw ApiError.notFound('Team not found');

    const access = policy.getTeamAccess(actor, team);
    if (access === ACCESS.NONE) {
      throw ApiError.forbidden('You cannot view this team');
    }

    const obj = team.toObject ? team.toObject() : team;
    return { ...obj, accessMode: access, canManage: access === ACCESS.MANAGE };
  }

  async update(id, updates, actorInput) {
    const actor = await resolveActor(actorInput);
    const existing = await teamRepository.findById(id);
    if (!existing) throw ApiError.notFound('Team not found');
    policy.assertTeamManage(actor, existing);

    // Non-SA cannot move teams across departments
    if (
      updates.department &&
      actor.role !== ROLES.SUPER_ADMIN &&
      String(updates.department) !== String(existing.department)
    ) {
      throw ApiError.forbidden('Only Super Admin can move teams between departments');
    }

    const team = await teamRepository.updateById(id, updates);
    if (!team) throw ApiError.notFound('Team not found');
    return team;
  }

  /**
   * @param {string} teamId
   * @param {string} userId
   * @param {string|null} actorId - inviter / actor id for notifications
   * @param {object|null} actorContext - when provided, enforces TEAM_MANAGE
   */
  async addMember(teamId, userId, actorId = null, actorContext = null) {
    const team = await teamRepository.findById(teamId);
    if (!team) throw ApiError.notFound('Team not found');

    if (actorContext) {
      const actor = await resolveActor(actorContext);
      policy.assertTeamManage(actor, team);
    }

    const user = await userRepository.findById(userId);
    if (!user) throw ApiError.notFound('User not found');

    await teamRepository.addMember(teamId, userId);

    if (team.department) {
      await userRepository.updateById(userId, { department: team.department });
    }

    // ClickUp-style: joining a team unlocks that team's projects
    await Project.updateMany({ team: teamId }, { $addToSet: { members: userId } });

    // Keep team chat participants in sync
    try {
      const chatService = require('./chat.service');
      await chatService.syncTeamConversationParticipants(teamId);
    } catch {
      /* non-fatal */
    }

    const teamProjects = await Project.find({ team: teamId })
      .select('_id name owner members team')
      .lean();

    let io = null;
    try {
      io = getIO();
    } catch {
      io = null;
    }
    if (io) {
      io.to(`user:${String(userId)}`).emit('team:member-added', {
        teamId: String(teamId),
        teamName: team.name,
        projectIds: teamProjects.map((p) => String(p._id)),
      });
    }
    for (const project of teamProjects) {
      emitProjectEvent('project:updated', project, {
        teamId,
        ownerId: project.owner,
        memberIds: [...(project.members || []).map(String), String(userId)],
      });
    }

    const projectNames = teamProjects
      .map((p) => p.name)
      .filter(Boolean)
      .slice(0, 5);
    const projectHint = projectNames.length
      ? ` Projects now visible: ${projectNames.join(', ')}${teamProjects.length > 5 ? '…' : ''}.`
      : '';

    if (actorId && String(actorId) !== String(userId)) {
      await notificationService
        .notify({
          recipient: userId,
          sender: actorId,
          type: NOTIFICATION_TYPES.PROJECT_INVITE,
          message: `You were added to team "${team.name}".${projectHint}`,
          entityType: 'Project',
          entityId: teamProjects[0]?._id || teamId,
          emailToo: true,
        })
        .catch(() => {});
    }

    return teamRepository.findById(teamId, {
      populate: [
        { path: 'lead', select: 'name avatarUrl jobTitle role email' },
        { path: 'members', select: 'name avatarUrl email jobTitle role' },
        { path: 'department', select: 'name code' },
      ],
    });
  }

  async removeMember(teamId, userId, actorInput) {
    const actor = await resolveActor(actorInput);
    const existing = await teamRepository.findById(teamId);
    if (!existing) throw ApiError.notFound('Team not found');
    policy.assertTeamManage(actor, existing);

    const team = await teamRepository.removeMember(teamId, userId);
    if (!team) throw ApiError.notFound('Team not found');

    // Drop membership on team projects, but never remove the project owner
    await Project.updateMany(
      { team: teamId, owner: { $ne: userId } },
      { $pull: { members: userId } }
    );

    try {
      const chatService = require('./chat.service');
      await chatService.syncTeamConversationParticipants(teamId);
    } catch {
      /* non-fatal */
    }

    let io = null;
    try {
      io = getIO();
    } catch {
      io = null;
    }
    if (io) {
      io.to(`user:${String(userId)}`).emit('team:member-removed', {
        teamId: String(teamId),
      });
    }

    return this.getById(teamId, actor);
  }
}

module.exports = new TeamService();
