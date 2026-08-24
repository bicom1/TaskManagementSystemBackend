const Task = require('../models/task.model');
const Notification = require('../models/notification.model');
const userRepository = require('../repositories/user.repository');
const ApiError = require('../utils/ApiError.util');
const { DEFAULT_HOME_CARDS, HOME_CARD_META } = require('../constants/home.constant');
const { NOTIFICATION_TYPES } = require('../constants/notification.constant');
const { cacheOrFetch } = require('../config/redis');
const {
  getUserWorkspace,
  getUpcomingMeetingsForUser,
  getLocationsForUser,
} = require('./workspace.util');

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfToday() {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d;
}

function daysFromNow(n) {
  const d = endOfToday();
  d.setDate(d.getDate() + n);
  return d;
}

function ensurePrefs(user) {
  const prefs = user.preferences || {};
  const homeCards =
    Array.isArray(prefs.homeCards) && prefs.homeCards.length
      ? prefs.homeCards
      : DEFAULT_HOME_CARDS.map((c) => ({ ...c }));
  return {
    homeCards,
    personalList: prefs.personalList || [],
    calendarProvider: prefs.calendarProvider || 'none',
    recentItems: prefs.recentItems || [],
  };
}

const TASK_POPULATE = [
  { path: 'assignees', select: 'name avatarUrl email' },
  { path: 'reporter', select: 'name avatarUrl' },
  { path: 'project', select: 'name key status' },
];

class HomeService {
  async getOverview(userId) {
    return cacheOrFetch(`home:overview:${userId}`, 20, () => this.#buildOverview(userId));
  }

  async #buildOverview(userId) {
    const user = await userRepository.findById(userId);
    if (!user) throw ApiError.notFound('User not found');

    const prefs = ensurePrefs(user);
    const uid = user._id;
    const workspace = await getUserWorkspace(uid);

    const [
      assignedToMe,
      myWork,
      todayOverdue,
      agenda,
      priorities,
      personalTasks,
      commentNotifs,
      meetings,
      locations,
      doneToday,
    ] = await Promise.all([
      Task.find({
        assignees: uid,
        isArchived: false,
        status: { $ne: 'done' },
        parentTask: null,
      })
        .sort({ dueDate: 1, updatedAt: -1 })
        .limit(25)
        .select('key title status priority dueDate assignees reporter project updatedAt')
        .populate(TASK_POPULATE)
        .lean(),

      Task.find({
        assignees: uid,
        isArchived: false,
        status: 'in_progress',
        parentTask: null,
      })
        .sort({ updatedAt: -1 })
        .limit(15)
        .select('key title status priority dueDate assignees reporter project updatedAt')
        .populate(TASK_POPULATE)
        .lean(),

      Task.find({
        assignees: uid,
        isArchived: false,
        status: { $ne: 'done' },
        parentTask: null,
        dueDate: { $lte: endOfToday() },
      })
        .sort({ dueDate: 1 })
        .limit(25)
        .select('key title status priority dueDate assignees reporter project updatedAt')
        .populate(TASK_POPULATE)
        .lean(),

      Task.find({
        assignees: uid,
        isArchived: false,
        status: { $ne: 'done' },
        parentTask: null,
        dueDate: { $gte: startOfToday(), $lte: daysFromNow(14) },
      })
        .sort({ dueDate: 1 })
        .limit(20)
        .select('key title status priority dueDate assignees reporter project updatedAt')
        .populate(TASK_POPULATE)
        .lean(),

      Task.find({
        assignees: uid,
        isArchived: false,
        status: { $ne: 'done' },
        parentTask: null,
        priority: { $in: ['high', 'urgent'] },
      })
        .sort({ priority: -1, dueDate: 1 })
        .limit(15)
        .select('key title status priority dueDate assignees reporter project updatedAt')
        .populate(TASK_POPULATE)
        .lean(),

      prefs.personalList.length
        ? Task.find({
            _id: { $in: prefs.personalList },
            isArchived: false,
          })
            .select('key title status priority dueDate assignees reporter project updatedAt')
            .populate(TASK_POPULATE)
            .lean()
        : Promise.resolve([]),

      Notification.find({
        recipient: uid,
        type: { $in: [NOTIFICATION_TYPES.COMMENT_ADDED, NOTIFICATION_TYPES.MENTIONED] },
      })
        .sort({ createdAt: -1 })
        .limit(15)
        .select('type message sender createdAt isRead entityId')
        .populate('sender', 'name avatarUrl')
        .lean(),

      getUpcomingMeetingsForUser(uid, { limit: 15, workspace }),
      getLocationsForUser(uid, workspace),
      Task.countDocuments({
        assignees: uid,
        status: 'done',
        updatedAt: { $gte: startOfToday() },
      }),
    ]);

    // Keep personal list order
    const personalMap = new Map(personalTasks.map((t) => [String(t._id), t]));
    const personalList = prefs.personalList
      .map((id) => personalMap.get(String(id)))
      .filter(Boolean);

    const recents =
      prefs.recentItems?.length > 0
        ? prefs.recentItems.slice(0, 10)
        : (workspace.projects || []).slice(0, 6).map((p) => ({
            type: 'project',
            refId: p._id,
            title: p.name,
            subtitle: p.team?.name ? `in ${p.team.name}` : 'in All Projects',
            projectId: p._id,
            at: p.updatedAt,
          }));

    const aiStandup = {
      greeting: this.#greeting(),
      summary: this.#buildStandup({
        assigned: assignedToMe.length,
        inProgress: myWork.length,
        overdue: todayOverdue.filter((t) => t.dueDate && t.dueDate < startOfToday()).length,
        dueToday: todayOverdue.filter(
          (t) => t.dueDate && t.dueDate >= startOfToday() && t.dueDate <= endOfToday()
        ).length,
        priorities: priorities.length,
        doneToday,
      }),
      counts: {
        assigned: assignedToMe.length,
        inProgress: myWork.length,
        overdue: todayOverdue.filter((t) => t.dueDate && t.dueDate < startOfToday()).length,
        dueToday: todayOverdue.filter(
          (t) => t.dueDate && t.dueDate >= startOfToday() && t.dueDate <= endOfToday()
        ).length,
        priorities: priorities.length,
        doneToday,
      },
    };

    return {
      preferences: {
        homeCards: prefs.homeCards,
        calendarProvider: prefs.calendarProvider,
        cardMeta: HOME_CARD_META,
      },
      workspace: {
        teams: workspace.teams,
        projects: workspace.projects,
      },
      cards: {
        recents,
        agenda,
        meetings,
        locations,
        my_work: myWork,
        assigned_to_me: assignedToMe,
        personal_list: personalList,
        assigned_comments: commentNotifs,
        priorities,
        ai_standup: aiStandup,
        today_overdue: todayOverdue,
      },
    };
  }

  async updatePreferences(userId, updates) {
    const user = await userRepository.findById(userId);
    if (!user) throw ApiError.notFound('User not found');

    const prefs = ensurePrefs(user);
    if (updates.homeCards) {
      prefs.homeCards = updates.homeCards.map((c, i) => ({
        id: c.id,
        enabled: c.enabled !== false,
        order: typeof c.order === 'number' ? c.order : i,
      }));
    }
    if (updates.calendarProvider) {
      prefs.calendarProvider = updates.calendarProvider;
    }

    const updated = await userRepository.updateById(userId, { preferences: prefs });
    return ensurePrefs(updated);
  }

  async addToPersonalList(userId, taskId) {
    const task = await Task.findById(taskId);
    if (!task) throw ApiError.notFound('Task not found');

    const user = await userRepository.findById(userId);
    const prefs = ensurePrefs(user);
    const id = String(taskId);
    if (!prefs.personalList.some((x) => String(x) === id)) {
      prefs.personalList.push(taskId);
      await userRepository.updateById(userId, { preferences: prefs });
    }
    return this.getOverview(userId);
  }

  async removeFromPersonalList(userId, taskId) {
    const user = await userRepository.findById(userId);
    const prefs = ensurePrefs(user);
    prefs.personalList = prefs.personalList.filter((x) => String(x) !== String(taskId));
    await userRepository.updateById(userId, { preferences: prefs });
    return this.getOverview(userId);
  }

  async trackRecent(userId, item) {
    const user = await userRepository.findById(userId);
    if (!user) throw ApiError.notFound('User not found');
    const prefs = ensurePrefs(user);

    const next = [
      {
        type: item.type,
        refId: item.refId,
        title: item.title,
        subtitle: item.subtitle || '',
        projectId: item.projectId || null,
        at: new Date(),
      },
      ...prefs.recentItems.filter(
        (r) => !(r.type === item.type && String(r.refId) === String(item.refId))
      ),
    ].slice(0, 20);

    prefs.recentItems = next;
    await userRepository.updateById(userId, { preferences: prefs });
    return next;
  }

  async listMyTasks(userId, { view = 'assigned' } = {}) {
    const user = await userRepository.findById(userId);
    const prefs = ensurePrefs(user);
    const uid = user._id;

    if (view === 'all') {
      const policy = require('./policy.service');
      const Project = require('../models/project.model');
      const actor = await policy.buildActorContext(userId);
      const scopeFilter = await policy.projectListFilter(actor);
      const projects = await Project.find(scopeFilter).select('_id').lean();
      const projectIds = projects.map((p) => p._id);
      if (!projectIds.length) return [];

      return Task.find({
        project: { $in: projectIds },
        isArchived: false,
        parentTask: null,
      })
        .sort({ updatedAt: -1 })
        .populate(TASK_POPULATE)
        .lean();
    }

    if (view === 'personal') {
      if (!prefs.personalList.length) return [];
      return Task.find({ _id: { $in: prefs.personalList }, isArchived: false })
        .populate(TASK_POPULATE)
        .lean();
    }

    if (view === 'today') {
      return Task.find({
        assignees: uid,
        isArchived: false,
        status: { $ne: 'done' },
        parentTask: null,
        dueDate: { $lte: endOfToday() },
      })
        .sort({ dueDate: 1 })
        .populate(TASK_POPULATE)
        .lean();
    }

    // assigned
    return Task.find({
      assignees: uid,
      isArchived: false,
      status: { $ne: 'done' },
      parentTask: null,
    })
      .sort({ dueDate: 1, updatedAt: -1 })
      .populate(TASK_POPULATE)
      .lean();
  }

  #greeting() {
    const h = new Date().getHours();
    if (h < 12) return 'Good morning';
    if (h < 18) return 'Good afternoon';
    return 'Good evening';
  }

  #buildStandup({ assigned, inProgress, overdue, dueToday, priorities, doneToday }) {
    const parts = [];
    parts.push(`You have ${assigned} open task${assigned === 1 ? '' : 's'} assigned.`);
    if (inProgress) parts.push(`${inProgress} in progress.`);
    if (dueToday) parts.push(`${dueToday} due today.`);
    if (overdue) parts.push(`${overdue} overdue — prioritize these first.`);
    if (priorities) parts.push(`${priorities} marked high/urgent.`);
    if (doneToday) parts.push(`Nice — ${doneToday} completed today.`);
    if (!assigned && !doneToday) parts.push('Your plate looks clear. Pick something from a project board.');
    return parts.join(' ');
  }
}

module.exports = new HomeService();
