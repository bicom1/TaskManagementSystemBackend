const mongoose = require('mongoose');
const Task = require('../models/task.model');
const Project = require('../models/project.model');
const Team = require('../models/team.model');
const User = require('../models/user.model');
const { cacheOrFetch } = require('../config/redis');
const policy = require('./policy.service');
const { PERMISSIONS } = require('../constants/permissions.constant');
const { ROLES } = require('../constants/roles.constant');
const ApiError = require('../utils/ApiError.util');

function toObjectId(projectId) {
  return new mongoose.Types.ObjectId(projectId);
}

function fillTrendDays(rows, days) {
  const map = Object.fromEntries((rows || []).map((r) => [r._id, r.completed]));
  const result = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 10);
    result.push({ _id: key, completed: map[key] || 0 });
  }
  return result;
}

async function assertProjectReportAccess(actorInput, projectId) {
  const actor = actorInput?.context || actorInput;
  const ctx = actor?.permissions ? actor : await policy.buildActorContext(actor.id);
  policy.assertPermission(ctx, PERMISSIONS.REPORT_VIEW);
  const project = await Project.findById(projectId).populate('team', 'department lead members').lean();
  if (!project) throw ApiError.notFound('Project not found');
  policy.assertProjectView(ctx, project);
  return ctx;
}

class ReportService {
  async projectSummary(projectId, actorInput) {
    await assertProjectReportAccess(actorInput, projectId);
    const oid = toObjectId(projectId);
    return cacheOrFetch(`report:project:${projectId}:summary`, 30, async () => {
      const [byStatus, byPriority, byApproval, overdueCount, totalCount] = await Promise.all([
        Task.aggregate([
          { $match: { project: oid, isArchived: false } },
          { $group: { _id: '$status', count: { $sum: 1 } } },
        ]),
        Task.aggregate([
          { $match: { project: oid, isArchived: false } },
          { $group: { _id: '$priority', count: { $sum: 1 } } },
        ]),
        Task.aggregate([
          { $match: { project: oid, isArchived: false } },
          { $group: { _id: '$approvalStatus', count: { $sum: 1 } } },
        ]),
        Task.countDocuments({
          project: oid,
          isArchived: false,
          dueDate: { $lt: new Date() },
          status: { $ne: 'done' },
        }),
        Task.countDocuments({ project: oid, isArchived: false }),
      ]);

      const byStatusMap = Object.fromEntries(byStatus.map((s) => [s._id, s.count]));
      const done = byStatusMap.done || 0;

      return {
        totalTasks: totalCount,
        overdueTasks: overdueCount,
        completedTasks: done,
        inProgressTasks: byStatusMap.in_progress || 0,
        pendingApproval: (Object.fromEntries(byApproval.map((a) => [a._id, a.count])).pending) || 0,
        completionRate: totalCount ? Math.round((done / totalCount) * 100) : 0,
        byStatus: byStatusMap,
        byPriority: Object.fromEntries(byPriority.map((p) => [p._id, p.count])),
        byApproval: Object.fromEntries(byApproval.map((a) => [a._id, a.count])),
      };
    });
  }

  async teamWorkload(projectId, actorInput) {
    await assertProjectReportAccess(actorInput, projectId);
    const oid = toObjectId(projectId);
    return cacheOrFetch(`report:project:${projectId}:workload`, 30, async () =>
      Task.aggregate([
        { $match: { project: oid, isArchived: false, status: { $ne: 'done' } } },
        { $unwind: '$assignees' },
        { $group: { _id: '$assignees', openTasks: { $sum: 1 } } },
        {
          $lookup: {
            from: 'users',
            localField: '_id',
            foreignField: '_id',
            as: 'user',
          },
        },
        { $unwind: '$user' },
        {
          $project: {
            _id: 0,
            userId: '$_id',
            name: '$user.name',
            avatarUrl: '$user.avatarUrl',
            jobTitle: '$user.jobTitle',
            openTasks: 1,
          },
        },
        { $sort: { openTasks: -1 } },
      ])
    );
  }

  async completionTrend(projectId, days = 14, actorInput) {
    await assertProjectReportAccess(actorInput, projectId);
    const oid = toObjectId(projectId);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    return cacheOrFetch(`report:project:${projectId}:trend:${days}`, 60, async () => {
      const rows = await Task.aggregate([
        {
          $match: {
            project: oid,
            status: 'done',
            updatedAt: { $gte: since },
          },
        },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$updatedAt' } },
            completed: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]);
      return fillTrendDays(rows, days);
    });
  }

  /** Role-scoped workspace snapshot */
  async workspaceOverview(actorInput) {
    const actor = actorInput?.context || actorInput;
    const ctx = actor?.permissions ? actor : await policy.buildActorContext(actor.id);
    policy.assertPermission(ctx, PERMISSIONS.REPORT_VIEW);

    const cacheKey =
      ctx.role === ROLES.SUPER_ADMIN
        ? 'report:workspace:overview:sa'
        : `report:workspace:overview:${ctx.role}:${ctx.id}`;

    return cacheOrFetch(cacheKey, 30, async () => {
      const projectFilter = await policy.projectListFilter(ctx);
      const visibleProjects = await Project.find(projectFilter).select('_id team').lean();
      const projectIds = visibleProjects.map((p) => p._id);
      const taskMatch = {
        isArchived: false,
        ...(projectIds.length ? { project: { $in: projectIds } } : { project: { $in: [] } }),
      };

      // Employees: only assigned tasks in reports
      if (ctx.role === ROLES.EMPLOYEE || ctx.role === ROLES.EXECUTIVE) {
        taskMatch.$or = [{ assignees: ctx.id }, { reporter: ctx.id }];
        delete taskMatch.project;
        if (projectIds.length) {
          taskMatch.$and = [
            { $or: [{ assignees: ctx.id }, { reporter: ctx.id }] },
            { project: { $in: projectIds } },
          ];
          delete taskMatch.$or;
        }
      }

      const teamFilter = policy.teamListFilter(ctx);
      const userFilter = policy.userListFilter(ctx);

      const [
        totalProjects,
        totalTeams,
        totalPeople,
        byStatus,
        byApproval,
        byPriority,
        overdueTasks,
        completedRecently,
        deptWorkload,
        trendRows,
        recentDone,
      ] = await Promise.all([
        Project.countDocuments({ ...projectFilter, status: { $ne: 'archived' } }),
        Team.countDocuments(teamFilter),
        User.countDocuments({ ...userFilter, isActive: true }),
        Task.aggregate([
          { $match: taskMatch },
          { $group: { _id: '$status', count: { $sum: 1 } } },
        ]),
        Task.aggregate([
          { $match: taskMatch },
          { $group: { _id: '$approvalStatus', count: { $sum: 1 } } },
        ]),
        Task.aggregate([
          { $match: taskMatch },
          { $group: { _id: '$priority', count: { $sum: 1 } } },
        ]),
        Task.countDocuments({
          ...taskMatch,
          dueDate: { $lt: new Date() },
          status: { $ne: 'done' },
        }),
        Task.countDocuments({
          ...taskMatch,
          status: 'done',
          updatedAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
        }),
        Task.aggregate([
          { $match: { ...taskMatch, status: { $ne: 'done' } } },
          {
            $lookup: {
              from: 'projects',
              localField: 'project',
              foreignField: '_id',
              as: 'projectDoc',
            },
          },
          { $unwind: '$projectDoc' },
          {
            $lookup: {
              from: 'teams',
              localField: 'projectDoc.team',
              foreignField: '_id',
              as: 'teamDoc',
            },
          },
          { $unwind: '$teamDoc' },
          {
            $lookup: {
              from: 'departments',
              localField: 'teamDoc.department',
              foreignField: '_id',
              as: 'deptDoc',
            },
          },
          { $unwind: { path: '$deptDoc', preserveNullAndEmptyArrays: true } },
          {
            $group: {
              _id: '$deptDoc.name',
              code: { $first: '$deptDoc.code' },
              openTasks: { $sum: 1 },
            },
          },
          { $sort: { openTasks: -1 } },
        ]),
        Task.aggregate([
          {
            $match: {
              ...taskMatch,
              status: 'done',
              updatedAt: { $gte: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000) },
            },
          },
          {
            $group: {
              _id: { $dateToString: { format: '%Y-%m-%d', date: '$updatedAt' } },
              completed: { $sum: 1 },
            },
          },
          { $sort: { _id: 1 } },
        ]),
        Task.find({ ...taskMatch, status: 'done' })
          .sort({ updatedAt: -1 })
          .limit(8)
          .populate('assignees', 'name')
          .populate('project', 'name key')
          .select('key title updatedAt project assignees')
          .lean(),
      ]);

      const byStatusMap = Object.fromEntries(byStatus.map((s) => [s._id, s.count]));
      const totalTasks = Object.values(byStatusMap).reduce((a, b) => a + b, 0);
      const done = byStatusMap.done || 0;

      return {
        scope: {
          role: ctx.role,
          departmentId: ctx.departmentId,
          canManageOrg: ctx.role === ROLES.SUPER_ADMIN,
          crossDepartmentView: ctx.role === ROLES.DEPT_HEAD || ctx.role === ROLES.SUPER_ADMIN,
          // SEO Head: may assign/edit other depts; delete only where they manage
          crossDepartmentEdit: ctx.role === ROLES.DEPT_HEAD || ctx.role === ROLES.SUPER_ADMIN,
          crossDepartmentDelete: ctx.role === ROLES.SUPER_ADMIN,
        },
        totals: {
          projects: totalProjects,
          teams: totalTeams,
          people: totalPeople,
          tasks: totalTasks,
          overdue: overdueTasks,
          completedThisWeek: completedRecently,
          pendingApproval:
            (Object.fromEntries(byApproval.map((a) => [a._id, a.count])).pending) || 0,
          completionRate: totalTasks ? Math.round((done / totalTasks) * 100) : 0,
        },
        byStatus: byStatusMap,
        byPriority: Object.fromEntries(byPriority.map((p) => [p._id, p.count])),
        byApproval: Object.fromEntries(byApproval.map((a) => [a._id, a.count])),
        byDepartment: deptWorkload.map((d) => ({
          name: d._id || 'Unassigned',
          code: d.code,
          openTasks: d.openTasks,
        })),
        trend: fillTrendDays(trendRows, 14),
        recentCompletions: recentDone.map((t) => ({
          id: t._id,
          key: t.key,
          title: t.title,
          project: t.project?.name,
          projectKey: t.project?.key,
          assignees: (t.assignees || []).map((a) => a.name),
          completedAt: t.updatedAt,
        })),
      };
    });
  }
}

module.exports = new ReportService();
