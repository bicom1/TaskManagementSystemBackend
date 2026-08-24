const Team = require('../models/team.model');
const Project = require('../models/project.model');
const Meeting = require('../models/meeting.model');
const Location = require('../models/location.model');
require('../models/department.model');
const { ROLES } = require('../constants/roles.constant');

/**
 * Resolve org membership for a user — used by Home, Channels, Meetings, Inbox.
 */
async function getUserWorkspace(userId) {
  const uid = String(userId);

  const teams = await Team.find({
    isActive: true,
    $or: [{ lead: userId }, { members: userId }],
  })
    .populate('department', 'name code')
    .populate('lead', 'name avatarUrl')
    .lean();

  const teamIds = teams.map((t) => t._id);
  const departmentIds = [
    ...new Set(
      teams
        .map((t) => t.department?._id || t.department)
        .filter(Boolean)
        .map(String)
    ),
  ];

  const projects = teamIds.length
    ? await Project.find({
        $or: [{ team: { $in: teamIds } }, { members: userId }, { owner: userId }],
      })
        .sort({ updatedAt: -1 })
        .limit(30)
        .select('name key status team updatedAt')
        .populate('team', 'name')
        .lean()
    : await Project.find({ $or: [{ members: userId }, { owner: userId }] })
        .sort({ updatedAt: -1 })
        .limit(30)
        .select('name key status team updatedAt')
        .populate('team', 'name')
        .lean();

  return { teams, teamIds, departmentIds, projects };
}

async function getUpcomingMeetingsForUser(userId, { limit = 20, workspace } = {}) {
  const { teamIds } = workspace || (await getUserWorkspace(userId));
  const now = new Date();

  return Meeting.find({
    isCancelled: false,
    endsAt: { $gte: now },
    $or: [
      { attendees: userId },
      { organizer: userId },
      ...(teamIds.length ? [{ team: { $in: teamIds } }] : []),
    ],
  })
    .sort({ startsAt: 1 })
    .limit(limit)
    .populate('team', 'name')
    .populate('location', 'name address city type')
    .populate('organizer', 'name avatarUrl')
    .select('title startsAt endsAt team location organizer attendees')
    .lean();
}

async function getLocationsForUser(userId, workspace) {
  const ws = workspace || (await getUserWorkspace(userId));
  const { teamIds, departmentIds } = ws;
  const filter = {
    isActive: true,
    $or: [
      { team: { $in: teamIds.length ? teamIds : ['000000000000000000000000'] } },
      { department: { $in: departmentIds.length ? departmentIds : ['000000000000000000000000'] } },
      { team: null, department: null },
    ],
  };

  const User = require('../models/user.model');
  const user = await User.findById(userId).select('role').lean();
  if (user?.role === ROLES.SUPER_ADMIN) {
    return Location.find({ isActive: true })
      .populate('team', 'name')
      .populate('department', 'name')
      .sort({ name: 1 })
      .select('name address city type team department')
      .lean();
  }

  return Location.find(filter)
    .populate('team', 'name')
    .populate('department', 'name')
    .sort({ name: 1 })
    .select('name address city type team department')
    .lean();
}

module.exports = {
  getUserWorkspace,
  getUpcomingMeetingsForUser,
  getLocationsForUser,
};
