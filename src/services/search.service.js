const Task = require('../models/task.model');
const Project = require('../models/project.model');
const User = require('../models/user.model');
const Team = require('../models/team.model');
const policy = require('./policy.service');

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function withAnd(filter, extra) {
  const parts = [];
  if (filter && Object.keys(filter).length) parts.push(filter);
  if (extra && Object.keys(extra).length) parts.push(extra);
  if (parts.length === 0) return {};
  if (parts.length === 1) return parts[0];
  return { $and: parts };
}

class SearchService {
  async search(actorInput, { q = '', limit = 8 } = {}) {
    const actor = actorInput?.context || actorInput;
    const ctx = actor?.permissions ? actor : await policy.buildActorContext(actor.id);
    const term = escapeRegex(String(q || '').trim()).slice(0, 80);
    if (term.length < 1) {
      return { people: [], tasks: [], projects: [], teams: [] };
    }

    const cap = Math.min(Math.max(Number(limit) || 8, 1), 20);
    const rx = { $regex: term, $options: 'i' };

    const [projectFilter, userFilter, teamFilter] = await Promise.all([
      policy.projectListFilter(ctx),
      Promise.resolve(policy.userListFilter(ctx)),
      Promise.resolve(policy.teamListFilter(ctx)),
    ]);

    const visibleProjects = await Project.find(projectFilter).select('_id').lean();
    const projectIds = visibleProjects.map((p) => p._id);

    const [people, projects, teams, tasks] = await Promise.all([
      User.find(
        withAnd(
          {
            ...userFilter,
            isActive: true,
            email: { $not: { $regex: '^deleted_', $options: 'i' } },
          },
          { $or: [{ name: rx }, { email: rx }, { jobTitle: rx }] }
        )
      )
        .select('name email role jobTitle avatarUrl department')
        .populate('department', 'name code')
        .sort({ name: 1 })
        .limit(cap)
        .lean(),

      Project.find(
        withAnd(
          { ...projectFilter, status: { $ne: 'archived' } },
          { $or: [{ name: rx }, { key: rx }] }
        )
      )
        .select('name key status color icon')
        .sort({ updatedAt: -1 })
        .limit(cap)
        .lean(),

      Team.find(withAnd(teamFilter, { name: rx }))
        .select('name department')
        .populate('department', 'name code')
        .sort({ name: 1 })
        .limit(cap)
        .lean(),

      Task.find({
        isArchived: false,
        parentTask: null,
        project: { $in: projectIds.length ? projectIds : [] },
        $or: [{ title: rx }, { key: rx }],
      })
        .select('key title status priority project assignees')
        .populate('project', 'name key')
        .populate('assignees', 'name avatarUrl')
        .sort({ updatedAt: -1 })
        .limit(cap)
        .lean(),
    ]);

    return {
      people: people.map((u) => ({
        id: String(u._id),
        name: u.name,
        email: u.email,
        role: u.role,
        jobTitle: u.jobTitle || '',
        avatarUrl: u.avatarUrl || null,
        department: u.department?.name || null,
      })),
      projects: projects.map((p) => ({
        id: String(p._id),
        name: p.name,
        key: p.key,
        status: p.status,
      })),
      teams: teams.map((t) => ({
        id: String(t._id),
        name: t.name,
        department: t.department?.name || null,
      })),
      tasks: tasks.map((t) => ({
        id: String(t._id),
        key: t.key,
        title: t.title,
        status: t.status,
        priority: t.priority,
        projectId: t.project?._id ? String(t.project._id) : null,
        project: t.project?.name || null,
        projectKey: t.project?.key || null,
      })),
    };
  }
}

module.exports = new SearchService();
