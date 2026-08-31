const Location = require('../models/location.model');
const Meeting = require('../models/meeting.model');
const Team = require('../models/team.model');
const ApiError = require('../utils/ApiError.util');
const notificationService = require('./notification.service');
const { NOTIFICATION_TYPES } = require('../constants/notification.constant');
const { notifySuperAdmins } = require('./notifySuperAdmins.util');
const {
  getUserWorkspace,
  getUpcomingMeetingsForUser,
  getLocationsForUser,
} = require('./workspace.util');

class MeetingService {
  async listForUser(userId) {
    return getUpcomingMeetingsForUser(userId, { limit: 50 });
  }

  async create(payload, actorId) {
    const {
      title,
      description,
      startsAt,
      endsAt,
      team,
      department,
      project,
      location,
      locationLabel,
      attendees = [],
      meetingUrl,
    } = payload;

    if (!startsAt || !endsAt) throw ApiError.badRequest('Start and end time are required');
    if (new Date(endsAt) <= new Date(startsAt)) {
      throw ApiError.badRequest('End time must be after start time');
    }

    let attendeeIds = [...new Set([actorId, ...attendees.map(String)])];

    if (team) {
      const teamDoc = await Team.findById(team).lean();
      if (!teamDoc) throw ApiError.notFound('Team not found');
      const teamPeople = [teamDoc.lead, ...(teamDoc.members || [])].map(String);
      attendeeIds = [...new Set([...attendeeIds, ...teamPeople])];
    }

    const meeting = await Meeting.create({
      title,
      description: description || '',
      startsAt,
      endsAt,
      team: team || null,
      department: department || null,
      project: project || null,
      location: location || null,
      locationLabel: locationLabel || '',
      organizer: actorId,
      attendees: attendeeIds,
      meetingUrl: meetingUrl || '',
    });

    await Promise.all(
      attendeeIds
        .filter((id) => String(id) !== String(actorId))
        .map((recipient) =>
          notificationService.notify({
            recipient,
            sender: actorId,
            type: NOTIFICATION_TYPES.MEETING_SCHEDULED,
            message: `Meeting scheduled: ${title}`,
            entityType: 'Meeting',
            entityId: meeting._id,
            emailToo: true,
            emailSubject: `Meeting: ${title}`,
          }).catch(() => {})
        )
    );

    await notifySuperAdmins({
      actorId,
      type: NOTIFICATION_TYPES.MEETING_SCHEDULED,
      message: `Meeting scheduled: "${title}"`,
      entityType: 'Meeting',
      entityId: meeting._id,
      emailSubject: `Meeting scheduled: ${title}`,
    });

    return Meeting.findById(meeting._id)
      .populate('team', 'name')
      .populate('location', 'name address city')
      .populate('organizer', 'name avatarUrl')
      .populate('attendees', 'name avatarUrl')
      .lean();
  }

  async listLocations(userId) {
    return getLocationsForUser(userId);
  }

  async createLocation(payload, actorId) {
    const location = await Location.create({
      name: payload.name,
      address: payload.address || '',
      city: payload.city || '',
      type: payload.type || 'office',
      team: payload.team || null,
      department: payload.department || null,
      createdBy: actorId,
    });
    return location;
  }

  async workspaceSummary(userId) {
    const workspace = await getUserWorkspace(userId);
    const [meetings, locations] = await Promise.all([
      getUpcomingMeetingsForUser(userId, { limit: 10 }),
      getLocationsForUser(userId),
    ]);
    return {
      teams: workspace.teams,
      projects: workspace.projects,
      meetings,
      locations,
    };
  }
}

module.exports = new MeetingService();
