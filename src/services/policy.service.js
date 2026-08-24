const Team = require('../models/team.model');
const Project = require('../models/project.model');
const User = require('../models/user.model');
const Department = require('../models/department.model');
const ApiError = require('../utils/ApiError.util');
const { ROLES, ROLE_RANK } = require('../constants/roles.constant');
const {
  PERMISSIONS,
  ACCESS,
  roleHasPermission,
  getPermissionsForRole,
  getInvitableRoles,
} = require('../constants/permissions.constant');

/**
 * Build a full authorization context for a user.
 * Cached on req.user.context when loaded via auth middleware.
 */
async function buildActorContext(userId) {
  const user = await User.findById(userId)
    .select('name email role department isActive')
    .lean();

  if (!user || !user.isActive) {
    throw ApiError.unauthorized('User account is inactive or not found');
  }

  const departmentId = user.department ? String(user.department) : null;

  const ledTeams = await Team.find({ lead: userId, isActive: true })
    .select('_id department')
    .lean();
  const memberTeams = await Team.find({
    isActive: true,
    $or: [{ lead: userId }, { members: userId }],
  })
    .select('_id department lead members')
    .lean();

  const ledTeamIds = ledTeams.map((t) => String(t._id));
  const teamIds = memberTeams.map((t) => String(t._id));
  const teamDepartmentIds = [
    ...new Set(
      memberTeams
        .map((t) => (t.department ? String(t.department) : null))
        .filter(Boolean)
    ),
  ];

  // Dept head may also be listed as department.head
  let headedDepartmentIds = [];
  if (user.role === ROLES.DEPT_HEAD || user.role === ROLES.SUPER_ADMIN) {
    const headed = await Department.find({
      isActive: true,
      ...(user.role === ROLES.SUPER_ADMIN ? {} : { $or: [{ head: userId }, { _id: departmentId }] }),
    })
      .select('_id')
      .lean();
    headedDepartmentIds = headed.map((d) => String(d._id));
  }
  if (departmentId && user.role === ROLES.DEPT_HEAD && !headedDepartmentIds.includes(departmentId)) {
    headedDepartmentIds.push(departmentId);
  }

  const projects = teamIds.length
    ? await Project.find({
        $or: [{ team: { $in: teamIds } }, { members: userId }, { owner: userId }],
      })
        .select('_id team members owner')
        .lean()
    : await Project.find({ $or: [{ members: userId }, { owner: userId }] })
        .select('_id team members owner')
        .lean();

  const projectIds = projects.map((p) => String(p._id));

  return {
    id: String(user._id),
    role: user.role,
    departmentId,
    headedDepartmentIds,
    ledTeamIds,
    teamIds,
    teamDepartmentIds,
    projectIds,
    permissions: getPermissionsForRole(user.role),
  };
}

function hasPermission(actor, permission) {
  if (!actor) return false;
  if (actor.role === ROLES.SUPER_ADMIN) return true;
  if (Array.isArray(actor.permissions)) {
    return actor.permissions.includes(permission);
  }
  return roleHasPermission(actor.role, permission);
}

function assertPermission(actor, permission) {
  if (!hasPermission(actor, permission)) {
    throw ApiError.forbidden(`Missing permission: ${permission}`);
  }
}

/**
 * Department access:
 * - Super Admin → manage all
 * - Dept Head → manage own dept(s); VIEW all other departments (cross-dept read)
 * - Team Lead / members → view own department(s) from teams
 */
function getDepartmentAccess(actor, departmentId) {
  if (!actor) return ACCESS.NONE;
  if (actor.role === ROLES.SUPER_ADMIN) return ACCESS.MANAGE;
  if (!departmentId) return ACCESS.NONE;

  const deptId = String(departmentId);
  const manages =
    (actor.headedDepartmentIds || []).includes(deptId) ||
    (actor.role === ROLES.DEPT_HEAD && actor.departmentId === deptId);

  if (manages) return ACCESS.MANAGE;

  // Dept heads can view every department (SEO Head → Dev/Designing read-only)
  if (actor.role === ROLES.DEPT_HEAD) return ACCESS.VIEW;

  if ((actor.teamDepartmentIds || []).includes(deptId) || actor.departmentId === deptId) {
    return ACCESS.VIEW;
  }

  return ACCESS.NONE;
}

/**
 * Team access:
 * - Super Admin → manage
 * - Dept Head → manage teams in own dept; view teams in other depts
 * - Team Lead → manage led teams; view other teams in same dept
 * - Members → view own teams
 */
function getTeamAccess(actor, team) {
  if (!actor || !team) return ACCESS.NONE;
  if (actor.role === ROLES.SUPER_ADMIN) return ACCESS.MANAGE;

  const teamId = String(team._id || team.id || team);
  const deptId = team.department
    ? String(team.department._id || team.department)
    : null;

  if ((actor.ledTeamIds || []).includes(teamId)) return ACCESS.MANAGE;

  if (deptId && (actor.headedDepartmentIds || []).includes(deptId)) {
    return ACCESS.MANAGE;
  }

  if (actor.role === ROLES.DEPT_HEAD) {
    return ACCESS.VIEW; // cross-department view
  }

  if ((actor.teamIds || []).includes(teamId)) return ACCESS.VIEW;

  if (deptId && getDepartmentAccess(actor, deptId) !== ACCESS.NONE) {
    return ACCESS.VIEW;
  }

  return ACCESS.NONE;
}

/**
 * Project access derived from its team + membership.
 */
function getProjectAccess(actor, project) {
  if (!actor || !project) return ACCESS.NONE;
  if (actor.role === ROLES.SUPER_ADMIN) return ACCESS.MANAGE;

  const projectId = String(project._id || project.id || project);
  const teamId = project.team ? String(project.team._id || project.team) : null;
  const deptId = project.team?.department
    ? String(project.team.department._id || project.team.department)
    : project.department
      ? String(project.department._id || project.department)
      : null;

  if (project.isPrivate) {
    const isOwner = String(project.owner?._id || project.owner) === actor.id;
    const isMember = (project.members || []).some((m) => String(m._id || m) === actor.id);
    const leadsTeam = teamId && (actor.ledTeamIds || []).includes(teamId);
    const headsDept = deptId && (actor.headedDepartmentIds || []).includes(deptId);
    if (!isOwner && !isMember && !leadsTeam && !headsDept) {
      return ACCESS.NONE;
    }
  }

  if ((actor.ledTeamIds || []).includes(teamId)) return ACCESS.MANAGE;
  if (deptId && (actor.headedDepartmentIds || []).includes(deptId)) return ACCESS.MANAGE;

  // Cross-dept view for SEO Head
  if (actor.role === ROLES.DEPT_HEAD) return ACCESS.VIEW;

  const isMember =
    (actor.projectIds || []).includes(projectId) ||
    (project.members || []).some((m) => String(m._id || m) === actor.id) ||
    String(project.owner?._id || project.owner) === actor.id ||
    (teamId && (actor.teamIds || []).includes(teamId));

  if (isMember) {
    // Team leads already handled; employees get view (edit via task scope)
    if (actor.role === ROLES.TEAM_LEAD && (actor.teamIds || []).includes(teamId)) {
      return ACCESS.MANAGE;
    }
    return ACCESS.VIEW;
  }

  if (deptId && getDepartmentAccess(actor, deptId) === ACCESS.VIEW) {
    return ACCESS.VIEW;
  }

  return ACCESS.NONE;
}

/**
 * Task access:
 * - Manage if can manage the project/team, OR assignee editing own work fields
 * - View if can view the project
 */
function getTaskAccess(actor, task, project) {
  if (!actor || !task) return ACCESS.NONE;
  if (actor.role === ROLES.SUPER_ADMIN) return ACCESS.MANAGE;

  const projectAccess = project ? getProjectAccess(actor, project) : ACCESS.NONE;
  if (projectAccess === ACCESS.MANAGE) return ACCESS.MANAGE;

  const isAssignee = (task.assignees || []).some(
    (a) => String(a._id || a) === actor.id
  );
  const isReporter = String(task.reporter?._id || task.reporter) === actor.id;

  if (isAssignee || isReporter) {
    // Employees/executives can edit their assigned work; not delete/reassign freely
    return ACCESS.MANAGE;
  }

  // Visible project + edit/assign: may update/reassign (delete still needs project MANAGE)
  // Covers SEO Head on Designing/Development and general team members editing visible work
  if (
    projectAccess === ACCESS.VIEW &&
    (hasPermission(actor, PERMISSIONS.TASK_EDIT) ||
      hasPermission(actor, PERMISSIONS.TASK_ASSIGN) ||
      actor.role === ROLES.DEPT_HEAD)
  ) {
    return ACCESS.MANAGE;
  }

  if (projectAccess === ACCESS.VIEW) return ACCESS.VIEW;

  return ACCESS.NONE;
}

function canManageResource(access) {
  return access === ACCESS.MANAGE;
}

function canViewResource(access) {
  return access === ACCESS.VIEW || access === ACCESS.MANAGE;
}

/**
 * Mongo filter for listing users visible to actor.
 */
function userListFilter(actor) {
  // Assignment is org-wide: every role can pick any active colleague (any department).
  if (actor.role === ROLES.SUPER_ADMIN) {
    return {};
  }
  return { isActive: true };
}

/**
 * Project list filter for actor.
 */
async function projectListFilter(actor) {
  if (actor.role === ROLES.SUPER_ADMIN) return {};

  if (actor.role === ROLES.DEPT_HEAD) {
    // View all projects (manage filtered at write time)
    return {};
  }

  if ((actor.teamIds || []).length || (actor.projectIds || []).length) {
    return {
      $or: [
        ...(actor.teamIds?.length ? [{ team: { $in: actor.teamIds } }] : []),
        ...(actor.projectIds?.length ? [{ _id: { $in: actor.projectIds } }] : []),
        { members: actor.id },
        { owner: actor.id },
      ],
    };
  }

  return { members: actor.id };
}

/**
 * Team list filter for actor.
 */
function teamListFilter(actor) {
  if (actor.role === ROLES.SUPER_ADMIN || actor.role === ROLES.DEPT_HEAD) {
    return { isActive: true };
  }
  if ((actor.teamIds || []).length) {
    return { isActive: true, _id: { $in: actor.teamIds } };
  }
  return { isActive: true, _id: { $in: [] } };
}

function canInviteRole(actor, targetRole) {
  const allowed = getInvitableRoles(actor.role);
  return allowed.includes(targetRole);
}

function canManageUser(actor, targetUser) {
  if (!actor || !targetUser) return false;
  if (actor.role === ROLES.SUPER_ADMIN) return true;
  if (String(targetUser._id || targetUser.id) === actor.id) return false;

  const targetRole = targetUser.role;
  const targetDept = targetUser.department
    ? String(targetUser.department._id || targetUser.department)
    : null;

  // Cannot manage equal or higher rank
  if ((ROLE_RANK[targetRole] || 0) >= (ROLE_RANK[actor.role] || 0)) {
    return false;
  }

  if (actor.role === ROLES.DEPT_HEAD) {
    return (
      targetDept &&
      (actor.headedDepartmentIds || []).includes(targetDept)
    );
  }

  if (actor.role === ROLES.TEAM_LEAD) {
    // Can manage members of led teams only (checked with team membership by caller)
    return targetDept && (actor.teamDepartmentIds || []).includes(targetDept);
  }

  return false;
}

/**
 * Assert write access on a department-scoped resource.
 * Dept heads may VIEW other depts but not manage them.
 */
function assertDepartmentManage(actor, departmentId, action = 'manage this department') {
  const access = getDepartmentAccess(actor, departmentId);
  if (access !== ACCESS.MANAGE) {
    throw ApiError.forbidden(`You cannot ${action}`);
  }
}

function assertTeamManage(actor, team) {
  const access = getTeamAccess(actor, team);
  if (access !== ACCESS.MANAGE) {
    throw ApiError.forbidden('You cannot manage this team');
  }
}

function assertProjectManage(actor, project) {
  const access = getProjectAccess(actor, project);
  if (access !== ACCESS.MANAGE) {
    throw ApiError.forbidden('You cannot manage this project');
  }
}

function assertProjectView(actor, project) {
  const access = getProjectAccess(actor, project);
  if (!canViewResource(access)) {
    throw ApiError.forbidden('You cannot view this project');
  }
}

function assertTaskView(actor, task, project) {
  const access = getTaskAccess(actor, task, project);
  if (!canViewResource(access)) {
    throw ApiError.forbidden('You cannot view this task');
  }
}

function assertTaskManage(actor, task, project) {
  const access = getTaskAccess(actor, task, project);
  if (!canManageResource(access)) {
    throw ApiError.forbidden('You cannot modify this task');
  }
}

/**
 * Whether actor may assign/create tasks in a project (not just view).
 */
function canAssignInProject(actor, project) {
  if (!hasPermission(actor, PERMISSIONS.TASK_ASSIGN) && !hasPermission(actor, PERMISSIONS.TASK_CREATE)) {
    return false;
  }
  const access = getProjectAccess(actor, project);
  if (access === ACCESS.MANAGE) return true;
  // Anyone with create/assign who can view the project may add/edit/reassign
  // (dept heads: SEO full manage; Dev/Designing view+edit; employees: own projects)
  if (
    access === ACCESS.VIEW &&
    (hasPermission(actor, PERMISSIONS.TASK_CREATE) ||
      hasPermission(actor, PERMISSIONS.TASK_ASSIGN) ||
      actor.role === ROLES.DEPT_HEAD ||
      actor.role === ROLES.EMPLOYEE ||
      actor.role === ROLES.EXECUTIVE ||
      actor.role === ROLES.TEAM_LEAD)
  ) {
    return true;
  }
  return false;
}

module.exports = {
  buildActorContext,
  hasPermission,
  assertPermission,
  getDepartmentAccess,
  getTeamAccess,
  getProjectAccess,
  getTaskAccess,
  canManageResource,
  canViewResource,
  userListFilter,
  projectListFilter,
  teamListFilter,
  canInviteRole,
  canManageUser,
  assertDepartmentManage,
  assertTeamManage,
  assertProjectManage,
  assertProjectView,
  assertTaskView,
  assertTaskManage,
  canAssignInProject,
  PERMISSIONS,
  ACCESS,
};
