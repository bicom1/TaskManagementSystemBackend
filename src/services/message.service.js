const Message = require('../models/message.model');
const userRepository = require('../repositories/user.repository');
const departmentRepository = require('../repositories/department.repository');
const teamRepository = require('../repositories/team.repository');
const notificationService = require('./notification.service');
const ApiError = require('../utils/ApiError.util');
const { NOTIFICATION_TYPES } = require('../constants/notification.constant');
const { ROLES } = require('../constants/roles.constant');
const { sendMail } = require('../emails/mailer.util');
const { emitMessage } = require('../socket/socket');

class MessageService {
  async send(payload, actorId) {
    const { to, department, team, subject, body, parentMessage, type = 'query' } = payload;

    if (!to && !department && !team) {
      throw ApiError.badRequest('Provide a recipient, department, or team');
    }

    let recipientIds = [];

    if (to) {
      recipientIds = [to];
    } else if (team) {
      const teamDoc = await teamRepository.findById(team);
      if (!teamDoc) throw ApiError.notFound('Team not found');
      recipientIds = [teamDoc.lead, ...(teamDoc.members || [])]
        .map((id) => id?.toString())
        .filter((id) => id && id !== String(actorId));
      recipientIds = [...new Set(recipientIds)];
    } else if (department) {
      const dept = await departmentRepository.findById(department);
      if (!dept) throw ApiError.notFound('Department not found');
      // All active members in the department (dynamic onboarding)
      const people = await userRepository.findPaginated(
        { isActive: true, department },
        { page: 1, limit: 200 }
      );
      recipientIds = (people.data || [])
        .map((u) => u._id.toString())
        .filter((id) => id !== String(actorId));
      if (dept.head) recipientIds.push(dept.head.toString());
      recipientIds = [...new Set(recipientIds)];
    }

    if (!recipientIds.length) {
      throw ApiError.badRequest('No recipients found for this query');
    }

    const messages = [];
    for (const recipientId of recipientIds) {
      // eslint-disable-next-line no-await-in-loop
      const message = await Message.create({
        from: actorId,
        to: recipientId,
        department: department || null,
        team: team || null,
        subject: subject || 'Query',
        body,
        parentMessage: parentMessage || null,
        type: type || 'query',
      });
      messages.push(message);

      // eslint-disable-next-line no-await-in-loop
      const populated = await Message.findById(message._id)
        .populate('from', 'name avatarUrl jobTitle role')
        .populate('to', 'name avatarUrl jobTitle role')
        .populate('department', 'name code')
        .populate('team', 'name')
        .lean();

      emitMessage(populated || message, [recipientId]);

      // eslint-disable-next-line no-await-in-loop
      await notificationService.notify({
        recipient: recipientId,
        sender: actorId,
        type: NOTIFICATION_TYPES.MESSAGE_RECEIVED,
        message: `New query: ${subject}`,
        entityType: 'Comment',
        entityId: message._id,
        emailToo: true,
      });

      // eslint-disable-next-line no-await-in-loop
      const recipient = await userRepository.findById(recipientId);
      if (recipient?.email) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await sendMail({
            to: recipient.email,
            subject: `[BIWORKSPACE] ${subject}`,
            html: `<p>You have a new workplace query.</p><p><strong>${subject}</strong></p><p>${body}</p>`,
          });
        } catch {
          /* logged by mailer */
        }
      }
    }

    return messages.length === 1 ? messages[0] : messages;
  }

  async inbox(userId, { page = 1, limit = 30 } = {}) {
    const skip = (page - 1) * limit;
    const filter = {
      $or: [{ to: userId }, { from: userId }],
    };

    const [data, total, unread] = await Promise.all([
      Message.find(filter)
        .populate('from', 'name avatarUrl jobTitle role')
        .populate('to', 'name avatarUrl jobTitle role')
        .populate('department', 'name code')
        .populate('team', 'name')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Message.countDocuments(filter),
      Message.countDocuments({ to: userId, isRead: false }),
    ]);

    return {
      data,
      unread,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 },
    };
  }

  async markRead(id, userId) {
    const message = await Message.findOneAndUpdate(
      { _id: id, to: userId },
      { isRead: true },
      { new: true }
    );
    if (!message) throw ApiError.notFound('Message not found');
    return message;
  }

  async markAllRead(userId) {
    await Message.updateMany({ to: userId, isRead: false }, { isRead: true });
    return { success: true };
  }

  async createTaskFromMessage(messageId, { projectId, title }, actor) {
    const message = await Message.findById(messageId)
      .populate('from', 'name')
      .exec();
    if (!message) throw ApiError.notFound('Message not found');

    const actorId = String(actor.id);
    const fromId = String(message.from?._id || message.from);
    const toId = String(message.to?._id || message.to);
    const isParticipant = toId === actorId || fromId === actorId;
    if (!isParticipant) {
      throw ApiError.forbidden('You can only create tasks from your own messages');
    }

    const taskTitle =
      (title && title.trim()) ||
      message.subject ||
      `Task from message`;

    const description = [
      message.body,
      '',
      `— Converted from inbox message`,
      message.from?.name ? `From: ${message.from.name}` : null,
      `Subject: ${message.subject}`,
    ]
      .filter(Boolean)
      .join('\n');

    const assignees = [];
    if (fromId !== actorId) {
      assignees.push(fromId);
    }

    const taskService = require('./task.service');
    const task = await taskService.create(
      {
        title: taskTitle.slice(0, 200),
        description: description.slice(0, 5000),
        project: projectId,
        assignees,
        status: 'todo',
      },
      actor
    );

    return task;
  }
}

module.exports = new MessageService();
