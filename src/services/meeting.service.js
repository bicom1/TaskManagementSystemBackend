const Location = require('../models/location.model');
const Meeting = require('../models/meeting.model');
const Team = require('../models/team.model');
const User = require('../models/user.model');
const ApiError = require('../utils/ApiError.util');
const notificationService = require('./notification.service');
const { NOTIFICATION_TYPES } = require('../constants/notification.constant');
const { notifySuperAdmins } = require('./notifySuperAdmins.util');
const {
  getUserWorkspace,
  getUpcomingMeetingsForUser,
  getLocationsForUser,
} = require('./workspace.util');

function formatMeetingWhen(startsAt, endsAt) {
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  const datePart = start.toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  const endPart = end.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${datePart} – ${endPart}`;
}

function collectTeamUserIds(teamDoc) {
  if (!teamDoc) return [];
  const ids = new Set();
  const leadId = teamDoc.lead?._id || teamDoc.lead;
  if (leadId) ids.add(String(leadId));
  for (const member of teamDoc.members || []) {
    const memberId = member?._id || member;
    if (memberId) ids.add(String(memberId));
  }
  return [...ids];
}

async function resolveMeetingRecipients({ team, attendees = [], actorId }) {
  const recipientIds = new Set();
  let teamDoc = null;

  for (const id of attendees.map(String).filter(Boolean)) {
    if (id !== String(actorId)) recipientIds.add(id);
  }

  if (team) {
    teamDoc = await Team.findById(team)
      .populate('lead', 'name email isActive')
      .populate('members', 'name email isActive')
      .lean();
    if (!teamDoc) throw ApiError.notFound('Team not found');

    for (const id of collectTeamUserIds(teamDoc)) {
      if (id !== String(actorId)) recipientIds.add(id);
    }
  }

  const ids = [...recipientIds];
  const activeUsers =
    ids.length > 0
      ? await User.find({ _id: { $in: ids }, isActive: true }).select('_id name email').lean()
      : [];

  return {
    teamDoc,
    attendeeIds: [...new Set([String(actorId), ...ids])],
    recipients: activeUsers,
  };
}

function buildInviteMessage({ title, startsAt, endsAt, organizerName, teamName, isTeamMeeting }) {
  const when = formatMeetingWhen(startsAt, endsAt);
  if (isTeamMeeting && teamName) {
    return `${organizerName} scheduled a team meeting "${title}" with ${teamName} on ${when}`;
  }
  return `${organizerName} scheduled a meeting with you: "${title}" on ${when}`;
}

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

    const hasTeam = Boolean(team);
    const hasAttendees = Array.isArray(attendees) && attendees.length > 0;
    if (!hasTeam && !hasAttendees) {
      throw ApiError.badRequest('Select a team or at least one person to invite');
    }

    const organizer = await User.findById(actorId).select('name email').lean();
    const organizerName = organizer?.name || 'Someone';

    const { teamDoc, attendeeIds, recipients } = await resolveMeetingRecipients({
      team,
      attendees,
      actorId,
    });

    if (!recipients.length) {
      throw ApiError.badRequest('No active recipients found for this meeting');
    }

    const isTeamMeeting = Boolean(teamDoc);
    const teamName = teamDoc?.name || '';

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

    const when = formatMeetingWhen(startsAt, endsAt);
    const inviteMessage = buildInviteMessage({
      title,
      startsAt,
      endsAt,
      organizerName,
      teamName,
      isTeamMeeting,
    });

    await Promise.all(
      recipients.map((recipient) =>
        notificationService
          .notify({
            recipient: recipient._id,
            sender: actorId,
            type: NOTIFICATION_TYPES.MEETING_SCHEDULED,
            message: inviteMessage,
            entityType: 'Meeting',
            entityId: meeting._id,
            emailToo: true,
            emailSubject: isTeamMeeting
              ? `Team meeting: ${title} (${teamName})`
              : `Meeting invite: ${title}`,
            metadata: {
              meetingTitle: title,
              startsAt,
              endsAt,
              teamName,
              organizerName,
              meetingUrl: meetingUrl || '',
            },
          })
          .catch(() => {})
      )
    );

    const notifiedIds = recipients.map((r) => String(r._id));
    await notifySuperAdmins({
      actorId,
      type: NOTIFICATION_TYPES.MEETING_SCHEDULED,
      message: `Meeting scheduled: "${title}"${teamName ? ` (${teamName})` : ''} · ${when} · ${recipients.length} invited`,
      entityType: 'Meeting',
      entityId: meeting._id,
      emailSubject: `Meeting scheduled: ${title}`,
      excludeIds: notifiedIds,
      metadata: {
        meetingTitle: title,
        startsAt,
        endsAt,
        teamName,
        organizerName,
      },
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
