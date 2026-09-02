const Task = require('../models/task.model');
const Project = require('../models/project.model');
const userRepository = require('../repositories/user.repository');
const policy = require('./policy.service');
const ApiError = require('../utils/ApiError.util');
const logger = require('../config/logger');
const { getOpenAIClient, resolveOpenAIModel } = require('../config/openai');
const { getUpcomingMeetingsForUser } = require('./workspace.util');

const SYSTEM_PROMPT = `You are Brain, the AI assistant inside BIWORKSPACE — a task and project management platform.

Help the user with their real workspace: tasks, projects, teams, meetings, status reports, emails, and planning.

Rules:
- Use the workspace context below when answering. If data is missing, say so clearly.
- Be concise, actionable, and professional. Use markdown lists and headings when helpful.
- Never invent task IDs, project names, or people not in the context.
- Do not claim you created or updated tasks in the app — suggest steps the user can take in BIWORKSPACE.
- Respect the user's role and permissions; only reference data provided in context.`;

function formatDate(value) {
  if (!value) return null;
  try {
    return new Date(value).toISOString().slice(0, 10);
  } catch {
    return null;
  }
}

async function buildWorkspaceContext(userId) {
  const user = await userRepository.findById(userId);
  if (!user) throw ApiError.notFound('User not found');

  const actor = await policy.buildActorContext(userId);
  const projectFilter = await policy.projectListFilter(actor);

  const [projects, assignedTasks, reportedTasks, meetings] = await Promise.all([
    Project.find({ ...projectFilter, status: { $ne: 'archived' } })
      .sort({ updatedAt: -1 })
      .limit(20)
      .select('name status color updatedAt')
      .lean(),
    Task.find({
      assignees: userId,
      isArchived: false,
      parentTask: null,
    })
      .sort({ dueDate: 1, updatedAt: -1 })
      .limit(20)
      .select('title status priority dueDate')
      .populate('project', 'name')
      .lean(),
    Task.find({
      reporter: userId,
      isArchived: false,
      parentTask: null,
    })
      .sort({ updatedAt: -1 })
      .limit(10)
      .select('title status priority dueDate')
      .populate('project', 'name')
      .lean(),
    getUpcomingMeetingsForUser(userId, { limit: 5 }),
  ]);

  const lines = [
    `User: ${user.name} (${user.role}${user.jobTitle ? `, ${user.jobTitle}` : ''})`,
    `Email: ${user.email}`,
    '',
    `Active projects (${projects.length}):`,
    projects.length
      ? projects
          .map((p) => `  - ${p.name} [${p.status}]`)
          .join('\n')
      : '  (none)',
    '',
    `Tasks assigned to user (${assignedTasks.length}):`,
    assignedTasks.length
      ? assignedTasks
          .map((t) => {
            const project = t.project?.name ? ` · ${t.project.name}` : '';
            const due = formatDate(t.dueDate) ? ` · due ${formatDate(t.dueDate)}` : '';
            return `  - ${t.title} [${t.status}]${project}${due}`;
          })
          .join('\n')
      : '  (none)',
    '',
    `Tasks reported by user (${reportedTasks.length}):`,
    reportedTasks.length
      ? reportedTasks
          .slice(0, 8)
          .map((t) => {
            const project = t.project?.name ? ` · ${t.project.name}` : '';
            return `  - ${t.title} [${t.status}]${project}`;
          })
          .join('\n')
      : '  (none)',
    '',
    `Upcoming meetings (${meetings.length}):`,
    meetings.length
      ? meetings
          .map((m) => {
            const when = formatDate(m.startsAt) || 'TBD';
            const team = m.team?.name ? ` · ${m.team.name}` : '';
            return `  - ${m.title} on ${when}${team}`;
          })
          .join('\n')
      : '  (none)',
  ];

  return lines.join('\n');
}

function sanitizeHistory(messages = []) {
  return messages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && String(m.content || '').trim())
    .slice(-16)
    .map((m) => ({
      role: m.role,
      content: String(m.content).trim().slice(0, 8000),
    }));
}

class AiService {
  async chat(actorId, { message, messages = [], model = 'max' }) {
    const prompt = String(message || '').trim();
    if (!prompt) throw ApiError.badRequest('Message is required');

    const openai = getOpenAIClient();
    if (!openai) {
      throw ApiError.serviceUnavailable(
        'AI is not configured on the server. Set OPENAI_API_KEY in the backend environment.'
      );
    }

    const workspaceContext = await buildWorkspaceContext(actorId);
    const history = sanitizeHistory(messages);
    const openaiModel = resolveOpenAIModel(model);

    const chatMessages = [
      {
        role: 'system',
        content: `${SYSTEM_PROMPT}\n\n--- Workspace context ---\n${workspaceContext}`,
      },
      ...history,
      { role: 'user', content: prompt },
    ];

    try {
      const completion = await openai.chat.completions.create({
        model: openaiModel,
        messages: chatMessages,
        temperature: model === 'fast' ? 0.4 : 0.6,
        max_tokens: model === 'fast' ? 900 : 1800,
      });

      const reply = completion.choices?.[0]?.message?.content?.trim();
      if (!reply) {
        throw ApiError.serviceUnavailable('AI returned an empty response. Please try again.');
      }

      return {
        reply,
        model: openaiModel,
        usage: completion.usage || null,
      };
    } catch (err) {
      logger.error(`OpenAI chat failed: ${err.message}`);
      if (err instanceof ApiError) throw err;

      const status = err?.status || err?.response?.status;
      if (status === 401) {
        throw ApiError.serviceUnavailable('OpenAI API key is invalid. Check OPENAI_API_KEY on the server.');
      }
      if (status === 429) {
        throw new ApiError(429, 'AI rate limit reached. Please wait a moment and try again.');
      }

      throw ApiError.serviceUnavailable(
        err?.message || 'AI request failed. Please try again in a moment.'
      );
    }
  }
}

module.exports = new AiService();
