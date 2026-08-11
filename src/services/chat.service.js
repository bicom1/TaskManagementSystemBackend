const Conversation = require('../models/conversation.model');
const Message = require('../models/message.model');
const User = require('../models/user.model');
const Team = require('../models/team.model');
const Department = require('../models/department.model');
const notificationService = require('./notification.service');
const ApiError = require('../utils/ApiError.util');
const { NOTIFICATION_TYPES } = require('../constants/notification.constant');
const { emitChatMessage, emitConversationUpdated } = require('../socket/socket');
const env = require('../config/env');

function dmKeyFor(userA, userB) {
  return [String(userA), String(userB)].sort().join(':');
}

function populateConversation(query) {
  return query
    .populate({
      path: 'participants',
      select: 'name email avatarUrl jobTitle role department',
      populate: { path: 'department', select: 'name code' },
    })
    .populate('team', 'name')
    .populate('department', 'name code')
    .populate('relatedTask', 'key title')
    .populate('relatedProject', 'name key')
    .populate('lastMessageBy', 'name avatarUrl');
}

function populateMessage(query) {
  return query
    .populate('from', 'name email avatarUrl jobTitle role department')
    .populate('mentions', 'name email avatarUrl jobTitle')
    .populate('to', 'name avatarUrl');
}

class ChatService {
  /**
   * Open directory for chat UI — any authenticated user (no role gate).
   */
  async listDirectory() {
    const [people, teams, departments] = await Promise.all([
      User.find({ isActive: true })
        .select('name email avatarUrl jobTitle role department lastLoginAt')
        .populate('department', 'name code')
        .sort({ name: 1 })
        .limit(200)
        .lean(),
      Team.find({ isActive: true })
        .select('name department lead')
        .populate('department', 'name code')
        .sort({ name: 1 })
        .lean(),
      Department.find({ isActive: true })
        .select('name code head')
        .sort({ name: 1 })
        .lean(),
    ]);
    return { people, teams, departments };
  }

  /**
   * Search all active employees by name, email, job title, department, role.
   * Open to every logged-in user — not role-scoped.
   */
  async searchPeople(actorId, { q = '', department, role, limit = 30 } = {}) {
    const filter = {
      isActive: true,
      _id: { $ne: actorId },
    };

    if (department) filter.department = department;
    if (role) filter.role = role;

    if (q && q.trim()) {
      const term = q.trim();
      const deptMatches = await Department.find({
        name: { $regex: term, $options: 'i' },
      })
        .select('_id')
        .lean();
      const deptIds = deptMatches.map((d) => d._id);

      filter.$or = [
        { name: { $regex: term, $options: 'i' } },
        { email: { $regex: term, $options: 'i' } },
        { jobTitle: { $regex: term, $options: 'i' } },
        ...(deptIds.length ? [{ department: { $in: deptIds } }] : []),
      ];
    }

    const people = await User.find(filter)
      .select('name email avatarUrl jobTitle role department lastLoginAt')
      .populate('department', 'name code')
      .sort({ name: 1 })
      .limit(Math.min(limit, 50))
      .lean();

    return people;
  }

  async listConversations(userId, { page = 1, limit = 40 } = {}) {
    const skip = (page - 1) * limit;
    const filter = { isActive: true, participants: userId };

    const [rows, total] = await Promise.all([
      populateConversation(
        Conversation.find(filter).sort({ lastMessageAt: -1 }).skip(skip).limit(limit)
      ).lean(),
      Conversation.countDocuments(filter),
    ]);

    const data = rows.map((c) => {
      const read = (c.readState || []).find((r) => String(r.user) === String(userId));
      const lastReadAt = read?.lastReadAt ? new Date(read.lastReadAt) : new Date(0);
      const unread =
        c.lastMessageAt && new Date(c.lastMessageAt) > lastReadAt
          ? String(c.lastMessageBy) !== String(userId)
          : false;
      return {
        ...c,
        unread,
        shareUrl: `${env.CLIENT_URL}/inbox?chat=${c._id}`,
      };
    });

    const unreadCount = data.filter((c) => c.unread).length;

    return {
      data,
      unread: unreadCount,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 },
    };
  }

  async getConversation(conversationId, userId) {
    const conversation = await populateConversation(Conversation.findById(conversationId)).lean();
    if (!conversation || !conversation.isActive) {
      throw ApiError.notFound('Conversation not found');
    }
    const isParticipant = (conversation.participants || []).some(
      (p) => String(p._id || p) === String(userId)
    );
    if (!isParticipant) throw ApiError.forbidden('You are not in this conversation');

    return {
      ...conversation,
      shareUrl: `${env.CLIENT_URL}/inbox?chat=${conversation._id}`,
    };
  }

  async getOrCreateDm(actorId, otherUserId) {
    if (String(actorId) === String(otherUserId)) {
      throw ApiError.badRequest('Cannot start a chat with yourself');
    }

    const other = await User.findById(otherUserId).select('_id name isActive').lean();
    if (!other || !other.isActive) throw ApiError.notFound('User not found');

    const dmKey = dmKeyFor(actorId, otherUserId);
    let conversation = await Conversation.findOne({ dmKey, type: 'dm' });

    if (!conversation) {
      conversation = await Conversation.create({
        type: 'dm',
        dmKey,
        participants: [actorId, otherUserId],
        createdBy: actorId,
        readState: [
          { user: actorId, lastReadAt: new Date() },
          { user: otherUserId, lastReadAt: new Date(0) },
        ],
        lastMessagePreview: 'Conversation started',
      });
    }

    return this.getConversation(conversation._id, actorId);
  }

  async getOrCreateTeamChat(actorId, teamId) {
    const team = await Team.findById(teamId).lean();
    if (!team) throw ApiError.notFound('Team not found');

    // Open chat: any logged-in user may join any team channel
    const memberIds = [
      ...new Set(
        [team.lead, ...(team.members || []), actorId]
          .map((id) => String(id))
          .filter(Boolean)
      ),
    ];

    let conversation = await Conversation.findOne({ type: 'team', team: teamId, isActive: true });
    if (!conversation) {
      conversation = await Conversation.create({
        type: 'team',
        team: teamId,
        department: team.department || null,
        title: team.name,
        participants: memberIds,
        createdBy: actorId,
        readState: memberIds.map((id) => ({
          user: id,
          lastReadAt: id === String(actorId) ? new Date() : new Date(0),
        })),
        lastMessagePreview: 'Team chat started',
      });
    } else {
      await Conversation.updateOne(
        { _id: conversation._id },
        { $addToSet: { participants: { $each: memberIds } } }
      );
    }

    return this.getConversation(conversation._id, actorId);
  }

  async getOrCreateDepartmentChat(actorId, departmentId) {
    const dept = await Department.findById(departmentId).lean();
    if (!dept) throw ApiError.notFound('Department not found');

    // Open chat: any logged-in user may join any department channel
    const people = await User.find({ isActive: true, department: departmentId })
      .select('_id')
      .lean();
    const memberIds = [...new Set(people.map((p) => String(p._id)))];
    if (dept.head) memberIds.push(String(dept.head));
    memberIds.push(String(actorId));
    const unique = [...new Set(memberIds)];

    let conversation = await Conversation.findOne({
      type: 'department',
      department: departmentId,
      isActive: true,
    });

    if (!conversation) {
      conversation = await Conversation.create({
        type: 'department',
        department: departmentId,
        title: dept.name,
        participants: unique,
        createdBy: actorId,
        readState: unique.map((id) => ({
          user: id,
          lastReadAt: id === String(actorId) ? new Date() : new Date(0),
        })),
        lastMessagePreview: 'Department chat started',
      });
    } else {
      await Conversation.updateOne(
        { _id: conversation._id },
        { $addToSet: { participants: { $each: unique } } }
      );
    }

    return this.getConversation(conversation._id, actorId);
  }

  async getOrCreateTaskChat(actorId, taskId) {
    const Task = require('../models/task.model');
    const task = await Task.findById(taskId)
      .populate('project', 'name key team')
      .lean();
    if (!task) throw ApiError.notFound('Task not found');

    // Any logged-in user can join a task chat
    const participantIds = [
      ...new Set(
        [
          actorId,
          task.reporter,
          ...(task.assignees || []),
        ]
          .map((id) => String(id?._id || id))
          .filter(Boolean)
      ),
    ];

    let conversation = await Conversation.findOne({
      type: 'task',
      relatedTask: taskId,
      isActive: true,
    });

    if (!conversation) {
      conversation = await Conversation.create({
        type: 'task',
        relatedTask: taskId,
        relatedProject: task.project?._id || task.project || null,
        title: `${task.key}: ${task.title}`.slice(0, 120),
        participants: participantIds,
        createdBy: actorId,
        readState: participantIds.map((id) => ({
          user: id,
          lastReadAt: id === String(actorId) ? new Date() : new Date(0),
        })),
        lastMessagePreview: 'Task chat started',
      });
    } else {
      await Conversation.updateOne(
        { _id: conversation._id },
        { $addToSet: { participants: { $each: participantIds } } }
      );
    }

    return this.getConversation(conversation._id, actorId);
  }

  async listMessages(conversationId, userId, { page = 1, limit = 50 } = {}) {
    await this.getConversation(conversationId, userId);

    const skip = (page - 1) * limit;
    const filter = { conversation: conversationId, type: 'chat' };

    const [data, total] = await Promise.all([
      populateMessage(
        Message.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit)
      ).lean(),
      Message.countDocuments(filter),
    ]);

    return {
      data: data.reverse(),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 },
    };
  }

  async sendChatMessage(conversationId, actorId, { body, mentions = [], shareLinks = [] }) {
    const conversation = await Conversation.findById(conversationId);
    if (!conversation || !conversation.isActive) {
      throw ApiError.notFound('Conversation not found');
    }

    const isParticipant = conversation.participants.some(
      (p) => String(p) === String(actorId)
    );
    if (!isParticipant) throw ApiError.forbidden('You are not in this conversation');

    const text = String(body || '').trim();
    if (!text && !(shareLinks || []).length) {
      throw ApiError.badRequest('Message cannot be empty');
    }

    const mentionIds = [...new Set((mentions || []).map(String))].filter((id) =>
      conversation.participants.some((p) => String(p) === id)
    );

    const message = await Message.create({
      from: actorId,
      conversation: conversationId,
      body: text || (shareLinks?.[0]?.label || 'Shared a link'),
      type: 'chat',
      subject: null,
      mentions: mentionIds,
      shareLinks: (shareLinks || []).slice(0, 5).map((l) => ({
        url: l.url,
        label: l.label || '',
        kind: l.kind || 'external',
        refId: l.refId || null,
      })),
      to: conversation.type === 'dm'
        ? conversation.participants.find((p) => String(p) !== String(actorId))
        : null,
      team: conversation.team || null,
      department: conversation.department || null,
    });

    conversation.lastMessageAt = new Date();
    conversation.lastMessagePreview = text.slice(0, 240);
    conversation.lastMessageBy = actorId;

    // Mark sender as read; others unread
    const readState = conversation.readState || [];
    const senderState = readState.find((r) => String(r.user) === String(actorId));
    if (senderState) {
      senderState.lastReadAt = new Date();
    } else {
      readState.push({ user: actorId, lastReadAt: new Date() });
    }
    conversation.readState = readState;
    await conversation.save();

    const populated = await populateMessage(Message.findById(message._id)).lean();
    const participantIds = conversation.participants.map(String);

    emitChatMessage(populated, participantIds, conversationId);
    emitConversationUpdated(
      {
        _id: conversation._id,
        lastMessageAt: conversation.lastMessageAt,
        lastMessagePreview: conversation.lastMessagePreview,
        lastMessageBy: actorId,
        type: conversation.type,
        title: conversation.title,
      },
      participantIds
    );

    // Notify mentioned users + other participants (lightweight)
    const notifyTargets = new Set(mentionIds);
    for (const pid of participantIds) {
      if (pid !== String(actorId) && mentionIds.includes(pid)) {
        notifyTargets.add(pid);
      }
    }

    await Promise.all(
      [...notifyTargets]
        .filter((id) => id !== String(actorId))
        .map((recipientId) =>
          notificationService.notify({
            recipient: recipientId,
            sender: actorId,
            type: mentionIds.includes(recipientId)
              ? NOTIFICATION_TYPES.MENTIONED
              : NOTIFICATION_TYPES.MESSAGE_RECEIVED,
            message: mentionIds.includes(recipientId)
              ? `Mentioned you in chat: ${text.slice(0, 80)}`
              : `New chat message: ${text.slice(0, 80)}`,
            entityType: 'Comment',
            entityId: message._id,
            emailToo: false,
          }).catch(() => {})
        )
    );

    return populated;
  }

  async markConversationRead(conversationId, userId) {
    const conversation = await Conversation.findById(conversationId);
    if (!conversation) throw ApiError.notFound('Conversation not found');

    const isParticipant = conversation.participants.some(
      (p) => String(p) === String(userId)
    );
    if (!isParticipant) throw ApiError.forbidden('You are not in this conversation');

    const idx = (conversation.readState || []).findIndex(
      (r) => String(r.user) === String(userId)
    );
    if (idx >= 0) {
      conversation.readState[idx].lastReadAt = new Date();
    } else {
      conversation.readState.push({ user: userId, lastReadAt: new Date() });
    }
    await conversation.save();
    return { success: true };
  }
}

module.exports = new ChatService();
