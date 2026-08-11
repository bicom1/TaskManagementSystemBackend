const Meeting = require('../models/meeting.model');
const {
  getUpcomingMeetingsForUser,
  getUserWorkspace,
} = require('./workspace.util');

function minutesUntil(date) {
  return Math.round((new Date(date).getTime() - Date.now()) / 60000);
}

class MeetingsAiService {
  async ask(userId, prompt = '') {
    const q = String(prompt || '').toLowerCase();
    const [upcoming, recent] = await Promise.all([
      getUpcomingMeetingsForUser(userId, { limit: 20 }),
      Meeting.find({
        isCancelled: false,
        $or: [{ attendees: userId }, { organizer: userId }],
        endsAt: { $lt: new Date() },
      })
        .sort({ endsAt: -1 })
        .limit(10)
        .populate('team', 'name')
        .populate('location', 'name city')
        .populate('organizer', 'name')
        .populate('attendees', 'name')
        .lean(),
    ]);

    const last = recent[0] || null;
    const next = upcoming[0] || null;

    let answer = '';
    let type = 'general';

    if (q.includes('summarize') || q.includes('highlight') || q.includes('last meeting') || q.includes('notes for')) {
      type = 'summary';
      const mentioned = [...upcoming, ...recent].find((m) =>
        q.includes(String(m.title || '').toLowerCase())
      );
      const target = mentioned || last;
      if (!target) {
        answer =
          'I could not find a past meeting yet. Schedule a team meeting and I will summarize notes here.';
      } else {
        const people = (target.attendees || []).map((a) => a.name).filter(Boolean);
        answer = [
          `Highlights from "${target.title}"${target.team?.name ? ` (${target.team.name})` : ''}:`,
          `• Organizer: ${target.organizer?.name || '—'}`,
          people.length ? `• Attendees: ${people.join(', ')}` : null,
          target.location?.name || target.locationLabel
            ? `• Location: ${target.location?.name || target.locationLabel}`
            : null,
          target.description
            ? `• Notes: ${target.description}`
            : '• Notes: No written notes were saved for this meeting yet.',
          target.meetingUrl ? `• Link: ${target.meetingUrl}` : null,
        ]
          .filter(Boolean)
          .join('\n');
      }
    } else if (q.includes('task') || q.includes('action')) {      type = 'actions';
      if (!last) {
        answer = 'No recent meeting found to extract action items from.';
      } else {
        const lines = String(last.description || '')
          .split(/[\n.;]+/)
          .map((s) => s.trim())
          .filter((s) => s.length > 8);
        if (lines.length) {
          answer = `Suggested action items from "${last.title}":\n${lines
            .slice(0, 5)
            .map((l, i) => `${i + 1}. ${l}`)
            .join('\n')}`;
        } else {
          answer = `No action items were written in "${last.title}". Add notes to the meeting description and I can turn them into tasks.`;
        }
      }
    } else if (q.includes('decision') || q.includes('key')) {
      type = 'decisions';
      if (!last) {
        answer = 'No past meetings available for decision review.';
      } else if (last.description) {
        answer = `Key points from "${last.title}":\n• ${last.description}`;
      } else {
        answer = `"${last.title}" has no decision notes yet. Capture decisions in the meeting description after the call.`;
      }
    } else if (q.includes('upcoming') || q.includes('next') || q.includes('today')) {
      type = 'upcoming';
      if (!upcoming.length) {
        answer = 'You have no upcoming meetings on your teams right now.';
      } else {
        answer = upcoming
          .slice(0, 5)
          .map((m) => {
            const mins = minutesUntil(m.startsAt);
            const when =
              mins <= 0
                ? 'starting now'
                : mins < 60
                  ? `in ${mins}m`
                  : new Date(m.startsAt).toLocaleString();
            return `• ${m.title} — ${when}${m.team?.name ? ` · ${m.team.name}` : ''}`;
          })
          .join('\n');
        answer = `Upcoming meetings:\n${answer}`;
      }
    } else {
      type = 'general';
      answer = [
        next
          ? `Your next meeting is "${next.title}" ${
              minutesUntil(next.startsAt) < 60 && minutesUntil(next.startsAt) > 0
                ? `in ${minutesUntil(next.startsAt)}m`
                : `at ${new Date(next.startsAt).toLocaleString()}`
            }.`
          : 'You have a clear calendar — no upcoming meetings.',
        last ? `Most recent: "${last.title}".` : null,
        'Try: “Summarize my most recent meeting notes”, “Create tasks from recent meeting action items”, or “What were the key decisions made in my last meeting?”',
      ]
        .filter(Boolean)
        .join(' ');
    }

    return {
      answer,
      type,
      context: {
        upcomingCount: upcoming.length,
        recentCount: recent.length,
        nextMeeting: next,
        lastMeeting: last,
      },
    };
  }

  async calendarBoard(userId) {
    const upcoming = await getUpcomingMeetingsForUser(userId, { limit: 30 });
    const workspace = await getUserWorkspace(userId);
    return {
      meetings: upcoming,
      teams: workspace.teams,
      day: new Date().toISOString(),
    };
  }
}

module.exports = new MeetingsAiService();
