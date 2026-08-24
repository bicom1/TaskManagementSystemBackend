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

  resolveAnalyticsRange(period = 'weekly', from, to) {
    const end = to ? new Date(to) : new Date();
    if (Number.isNaN(end.getTime())) throw ApiError.badRequest('Invalid end date');
    end.setHours(23, 59, 59, 999);

    const start = new Date(end);
    if (period === 'custom') {
      if (!from) throw ApiError.badRequest('Start date is required for a custom range');
      const customStart = new Date(from);
      if (Number.isNaN(customStart.getTime())) throw ApiError.badRequest('Invalid start date');
      customStart.setHours(0, 0, 0, 0);
      if (customStart > end) throw ApiError.badRequest('Start date must be before end date');
      return { start: customStart, end, period: 'custom' };
    }
    if (period === 'daily') {
      start.setHours(0, 0, 0, 0);
    } else if (period === 'monthly') {
      start.setDate(1);
      start.setHours(0, 0, 0, 0);
    } else {
      start.setDate(start.getDate() - 6);
      start.setHours(0, 0, 0, 0);
    }
    return { start, end, period: period === 'monthly' ? 'monthly' : period === 'daily' ? 'daily' : 'weekly' };
  }

  /**
   * Role-based workload analytics. Super Admin may filter org-wide.
   * Other roles only see their relevant slice (self / team / department).
   */
  async workloadAnalytics(actorInput, query = {}) {
    const actor = actorInput?.context || actorInput;
    const ctx = actor?.permissions ? actor : await policy.buildActorContext(actor.id);
    policy.assertPermission(ctx, PERMISSIONS.REPORT_VIEW);

    const { start, end, period } = this.resolveAnalyticsRange(
      query.period,
      query.from,
      query.to
    );
    const isSuperAdmin = ctx.role === ROLES.SUPER_ADMIN;
    const now = new Date();

    const projectFilter = await policy.projectListFilter(ctx);
    let visibleProjects = await Project.find(projectFilter)
      .select('_id name key team')
      .populate('team', 'name department')
      .lean();

    if (query.projectId && isSuperAdmin) {
      visibleProjects = visibleProjects.filter((p) => String(p._id) === String(query.projectId));
    }
    if (query.teamId && isSuperAdmin) {
      visibleProjects = visibleProjects.filter(
        (p) => String(p.team?._id || p.team) === String(query.teamId)
      );
    }
    if (query.departmentId && isSuperAdmin) {
      visibleProjects = visibleProjects.filter(
        (p) => String(p.team?.department) === String(query.departmentId)
      );
    }

    const projectIds = visibleProjects.map((p) => p._id);
    const taskMatch = {
      isArchived: false,
      project: { $in: projectIds.length ? projectIds : [] },
    };

    const userFilter = { isActive: true };
    if (!isSuperAdmin) {
      if (ctx.role === ROLES.DEPT_HEAD && (ctx.headedDepartmentIds || []).length) {
        userFilter.department = { $in: ctx.headedDepartmentIds };
      } else if (ctx.role === ROLES.TEAM_LEAD && (ctx.ledTeamIds || []).length) {
        const led = await Team.find({ _id: { $in: ctx.ledTeamIds } })
          .select('lead members')
          .lean();
        const ids = new Set([String(ctx.id)]);
        for (const t of led) {
          if (t.lead) ids.add(String(t.lead));
          for (const m of t.members || []) ids.add(String(m));
        }
        userFilter._id = { $in: [...ids] };
      } else {
        userFilter._id = ctx.id;
      }
    } else if (query.userId) {
      userFilter._id = query.userId;
    } else if (query.departmentId) {
      userFilter.department = query.departmentId;
    }

    const people = await User.find(userFilter)
      .select('name email role jobTitle avatarUrl department')
      .populate('department', 'name code')
      .sort({ name: 1 })
      .limit(300)
      .lean();

    const peopleIds = people.map((p) => p._id);
    if (peopleIds.length) {
      taskMatch.assignees = { $in: peopleIds };
    } else {
      taskMatch.assignees = { $in: [] };
    }

    const tasks = await Task.find(taskMatch)
      .select('title key status priority dueDate assignees project updatedAt createdAt approvalStatus')
      .populate('assignees', 'name')
      .populate({ path: 'project', select: 'name key team', populate: { path: 'team', select: 'name department' } })
      .lean();

    const personStats = new Map(
      people.map((p) => [
        String(p._id),
        {
          userId: String(p._id),
          name: p.name,
          email: p.email,
          role: p.role,
          jobTitle: p.jobTitle || '',
          department: p.department?.name || '',
          assigned: 0,
          completed: 0,
          pending: 0,
          overdue: 0,
          inProgress: 0,
          projects: new Set(),
          workload: 0,
        },
      ])
    );

    const projectStats = new Map();
    const teamStats = new Map();
    const trendMap = new Map();
    const cursor = new Date(start);
    cursor.setHours(12, 0, 0, 0);
    const endNoon = new Date(end);
    endNoon.setHours(12, 0, 0, 0);
    while (cursor <= endNoon) {
      const key = cursor.toISOString().slice(0, 10);
      trendMap.set(key, { date: key, completed: 0, created: 0 });
      cursor.setDate(cursor.getDate() + 1);
    }

    const dayKey = (d) => new Date(d).toISOString().slice(0, 10);
    const PRIORITY_WEIGHT = { low: 1, medium: 2, high: 3, urgent: 4 };

    for (const task of tasks) {
      const assigneeIds = (task.assignees || []).map((a) => String(a._id || a));
      const isDone = task.status === 'done';
      const isOverdue =
        !isDone && task.dueDate && new Date(task.dueDate) < now;
      const inRangeUpdated = task.updatedAt && new Date(task.updatedAt) >= start && new Date(task.updatedAt) <= end;
      const inRangeCreated = task.createdAt && new Date(task.createdAt) >= start && new Date(task.createdAt) <= end;

      if (isDone && inRangeUpdated) {
        const bucket = trendMap.get(dayKey(task.updatedAt));
        if (bucket) bucket.completed += 1;
      }
      if (inRangeCreated) {
        const bucket = trendMap.get(dayKey(task.createdAt));
        if (bucket) bucket.created += 1;
      }

      const pid = String(task.project?._id || task.project || '');
      if (pid) {
        const row = projectStats.get(pid) || {
          projectId: pid,
          name: task.project?.name || 'Project',
          key: task.project?.key || '',
          assigned: 0,
          completed: 0,
          overdue: 0,
          inProgress: 0,
        };
        row.assigned += 1;
        if (isDone && inRangeUpdated) row.completed += 1;
        if (isOverdue) row.overdue += 1;
        if (task.status === 'in_progress') row.inProgress += 1;
        projectStats.set(pid, row);
      }

      const teamId = String(task.project?.team?._id || task.project?.team || '');
      if (teamId) {
        const trow = teamStats.get(teamId) || {
          teamId,
          completed: 0,
          created: 0,
          open: 0,
        };
        if (isDone && inRangeUpdated) trow.completed += 1;
        if (inRangeCreated) trow.created += 1;
        if (!isDone) trow.open += 1;
        teamStats.set(teamId, trow);
      }

      for (const aid of assigneeIds) {
        const row = personStats.get(aid);
        if (!row) continue;
        row.assigned += 1;
        if (pid) row.projects.add(pid);
        if (isDone && inRangeUpdated) row.completed += 1;
        if (!isDone) {
          row.workload += PRIORITY_WEIGHT[task.priority] || 2;
          if (task.status === 'in_progress') row.inProgress += 1;
          else row.pending += 1;
          if (isOverdue) row.overdue += 1;
        }
      }
    }

    const teams = await Team.find({
      _id: { $in: [...teamStats.keys()].filter((id) => id && id.length === 24) },
    })
      .select('name department')
      .populate('department', 'name')
      .lean();
    const teamName = Object.fromEntries(
      teams.map((t) => [String(t._id), { name: t.name, department: t.department?.name || '' }])
    );

    const peopleRows = [...personStats.values()]
      .map((row) => ({
        ...row,
        projects: row.projects.size,
        productivity:
          row.assigned > 0 ? Math.round((row.completed / Math.max(row.assigned, 1)) * 100) : 0,
      }))
      .sort((a, b) => b.workload - a.workload || b.assigned - a.assigned);

    const summary = peopleRows.reduce(
      (acc, row) => {
        acc.assigned += row.assigned;
        acc.completed += row.completed;
        acc.pending += row.pending;
        acc.overdue += row.overdue;
        acc.inProgress += row.inProgress;
        acc.workload += row.workload;
        return acc;
      },
      { assigned: 0, completed: 0, pending: 0, overdue: 0, inProgress: 0, workload: 0 }
    );
    summary.people = peopleRows.length;
    summary.projects = projectStats.size;
    summary.completionRate = summary.assigned
      ? Math.round((summary.completed / summary.assigned) * 100)
      : 0;

    return {
      period,
      range: { from: start.toISOString(), to: end.toISOString() },
      scope: {
        role: ctx.role,
        canFilterOrg: isSuperAdmin,
      },
      summary,
      people: peopleRows,
      projects: [...projectStats.values()].sort((a, b) => b.assigned - a.assigned).slice(0, 20),
      teams: [...teamStats.entries()]
        .map(([id, row]) => ({
          ...row,
          name: teamName[id]?.name || 'Team',
          department: teamName[id]?.department || '',
        }))
        .sort((a, b) => b.completed - a.completed)
        .slice(0, 20),
      trend: [...trendMap.values()],
    };
  }
}

module.exports = new ReportService();
