const Conversation = require('../models/conversation.model');
const Message = require('../models/message.model');
const User = require('../models/user.model');
const Team = require('../models/team.model');
const Department = require('../models/department.model');
const notificationService = require('./notification.service');
const ApiError = require('../utils/ApiError.util');
const { NOTIFICATION_TYPES } = require('../constants/notification.constant');
const { ROLES } = require('../constants/roles.constant');
const {
  MAX_FILES_PER_MESSAGE,
  MAX_LINKS_PER_MESSAGE,
  IMAGE_MAX_BYTES,
  DOCUMENT_MAX_BYTES,
  IMAGE_MIME_TYPES,
} = require('../constants/chat.constant');
const { emitChatMessage, emitConversationUpdated } = require('../socket/socket');
const env = require('../config/env');

function dmKeyFor(userA, userB) {
  return [String(userA), String(userB)].sort().join(':');
}

function uniqueIds(ids) {
  return [...new Set((ids || []).map((id) => String(id?._id || id)).filter(Boolean))];
}

function uniqueById(rows, getId) {
  const seen = new Set();
  const out = [];
  for (const row of rows || []) {
    const id = getId(row);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(row);
  }
  return out;
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

function isTeamMember(team, userId) {
  const id = String(userId);
  if (String(team.lead) === id) return true;
  return (team.members || []).some((m) => String(m) === id);
}

function previewFromMessage({ text, attachments, shareLinks }) {
  if (text) return text.slice(0, 240);
  if ((attachments || []).length) {
    const first = attachments[0];
    const kind = String(first.fileType || '').startsWith('image/') ? 'image' : 'file';
    return attachments.length > 1
      ? `Shared ${attachments.length} ${kind === 'image' ? 'images' : 'files'}`
      : `Shared ${kind}: ${first.fileName || 'attachment'}`;
  }
  if ((shareLinks || []).length) {
    return `Shared a link: ${shareLinks[0].label || shareLinks[0].url}`.slice(0, 240);
  }
  return 'New message';
}

class ChatService {
  /**
   * Directory for chat UI. Teams list is membership-scoped (plus SA sees all).
   */
  async listDirectory(actorId) {
    const actor = await User.findById(actorId).select('role').lean();
    const isSuperAdmin = actor?.role === ROLES.SUPER_ADMIN;

    const [people, allTeams, departments] = await Promise.all([
      User.find({ isActive: true })
        .select('name email avatarUrl jobTitle role department lastLoginAt')
        .populate('department', 'name code')
        .sort({ name: 1 })
        .limit(200)
        .lean(),
      Team.find({ isActive: true })
        .select('name department lead members')
        .populate('department', 'name code')
        .sort({ name: 1 })
        .lean(),
      Department.find({ isActive: true })
        .select('name code head')
        .sort({ name: 1 })
        .lean(),
    ]);

    const myTeams = uniqueById(
      allTeams.filter((t) => isTeamMember(t, actorId)),
      (t) => String(t._id)
    );
    const teams = uniqueById(isSuperAdmin ? allTeams : myTeams, (t) => String(t._id));

    return {
      people: uniqueById(people, (p) => String(p._id)),
      teams,
      myTeams,
      departments: uniqueById(departments, (d) => String(d._id)),
      limits: {
        maxFiles: MAX_FILES_PER_MESSAGE,
        maxLinks: MAX_LINKS_PER_MESSAGE,
        imageMaxBytes: IMAGE_MAX_BYTES,
        documentMaxBytes: DOCUMENT_MAX_BYTES,
      },
    };
  }

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

    const data = uniqueById(rows, (c) => {
      if (c.type === 'team') return `team:${String(c.team?._id || c.team || c._id)}`;
      if (c.type === 'department') return `dept:${String(c.department?._id || c.department || c._id)}`;
      return String(c._id);
    }).map((c) => {
      const read = (c.readState || []).find((r) => String(r.user) === String(userId));
      const lastReadAt = read?.lastReadAt ? new Date(read.lastReadAt) : new Date(0);
      const unread =
        c.lastMessageAt && new Date(c.lastMessageAt) > lastReadAt
          ? String(c.lastMessageBy) !== String(userId)
          : false;
      return {
        ...c,
        participants: uniqueById(c.participants || [], (p) => String(p._id || p)),
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
      participants: uniqueById(conversation.participants || [], (p) => String(p._id || p)),
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

  async assertCanAccessTeamChat(actorId, team) {
    const actor = await User.findById(actorId).select('role').lean();
    if (actor?.role === ROLES.SUPER_ADMIN) return true;
    if (isTeamMember(team, actorId)) return true;
    throw ApiError.forbidden('Only team members and leads can open this team chat');
  }

  async stripGroupChatDmKeys() {
    await Conversation.updateMany(
      { type: { $in: ['team', 'department', 'task'] }, dmKey: { $ne: null } },
      { $unset: { dmKey: 1 } }
    );
    await Conversation.updateMany(
      { type: { $in: ['team', 'department', 'task'] }, dmKey: null },
      { $unset: { dmKey: 1 } }
    );
  }

  async collapseDuplicateTeamChats(teamId) {
    const convos = await Conversation.find({
      type: 'team',
      team: teamId,
    }).sort({ isActive: -1, createdAt: 1 });
    if (!convos.length) return null;

    const keep = convos[0];
    const extras = convos.slice(1);
    if (extras.length) {
      const extraIds = extras.map((c) => c._id);
      await Message.updateMany(
        { conversation: { $in: extraIds } },
        { $set: { conversation: keep._id } }
      );
      await Conversation.updateMany(
        { _id: { $in: extraIds } },
        { $set: { isActive: false } }
      );
    }
    if (!keep.isActive) {
      keep.isActive = true;
      await keep.save();
    }
    return keep;
  }

  async getOrCreateTeamChat(actorId, teamId) {
    const team = await Team.findById(teamId).lean();
    if (!team) throw ApiError.notFound('Team not found');

    await this.assertCanAccessTeamChat(actorId, team);
    await this.stripGroupChatDmKeys();

    const memberIds = uniqueIds([team.lead, ...(team.members || []), actorId]);

    let conversation = await this.collapseDuplicateTeamChats(teamId);
    if (!conversation) {
      try {
        conversation = await Conversation.create({
          type: 'team',
          team: teamId,
          department: team.department || null,
          title: `${team.name} · Team`,
          participants: memberIds,
          createdBy: actorId,
          readState: memberIds.map((id) => ({
            user: id,
            lastReadAt: id === String(actorId) ? new Date() : new Date(0),
          })),
          lastMessagePreview: 'Team chat started',
        });
        await Conversation.updateOne({ _id: conversation._id }, { $unset: { dmKey: 1 } });
      } catch (err) {
        if (err?.code !== 11000) throw err;
        conversation = await this.collapseDuplicateTeamChats(teamId);
        if (!conversation) throw err;
      }
    } else {
      conversation.participants = uniqueIds([
        ...(conversation.participants || []),
        ...memberIds,
      ]);
      conversation.title = `${team.name} · Team`;
      conversation.isActive = true;
      if (conversation.dmKey != null) conversation.dmKey = undefined;
      await conversation.save();
    }

    return this.getConversation(conversation._id, actorId);
  }

  /** Keep team conversation participants in sync when roster changes */
  async syncTeamConversationParticipants(teamId) {
    const team = await Team.findById(teamId).lean();
    if (!team) return null;

    const memberIds = uniqueIds([team.lead, ...(team.members || [])]);
    const conversation = await this.collapseDuplicateTeamChats(teamId);
    if (!conversation) return null;

    conversation.participants = memberIds;
    conversation.title = `${team.name} · Team`;
    await conversation.save();
    return conversation;
  }

  async getOrCreateDepartmentChat(actorId, departmentId) {
    const dept = await Department.findById(departmentId).lean();
    if (!dept) throw ApiError.notFound('Department not found');

    const actor = await User.findById(actorId).select('role department').lean();
    const isSuperAdmin = actor?.role === ROLES.SUPER_ADMIN;
    const inDept =
      String(actor?.department || '') === String(departmentId) ||
      String(dept.head || '') === String(actorId);
    if (!isSuperAdmin && !inDept) {
      throw ApiError.forbidden('Only department members can open this channel');
    }

    await this.stripGroupChatDmKeys();

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
    }).sort({ isActive: -1, createdAt: 1 });

    if (!conversation) {
      try {
        conversation = await Conversation.create({
          type: 'department',
          department: departmentId,
          title: `${dept.name} · Department`,
          participants: unique,
          createdBy: actorId,
          readState: unique.map((id) => ({
            user: id,
            lastReadAt: id === String(actorId) ? new Date() : new Date(0),
          })),
          lastMessagePreview: 'Department chat started',
        });
        await Conversation.updateOne({ _id: conversation._id }, { $unset: { dmKey: 1 } });
      } catch (err) {
        if (err?.code !== 11000) throw err;
        conversation = await Conversation.findOne({
          type: 'department',
          department: departmentId,
        }).sort({ createdAt: 1 });
        if (!conversation) throw err;
      }
    }

    await Conversation.updateOne(
      { _id: conversation._id },
      {
        $addToSet: { participants: { $each: unique } },
        $set: { isActive: true, title: `${dept.name} · Department` },
        $unset: { dmKey: 1 },
      }
    );

    return this.getConversation(conversation._id, actorId);
  }

  async getOrCreateTaskChat(actorId, taskId) {
    const Task = require('../models/task.model');
    const task = await Task.findById(taskId)
      .populate('project', 'name key team')
      .lean();
    if (!task) throw ApiError.notFound('Task not found');

    const participantIds = [
      ...new Set(
        [actorId, task.reporter, ...(task.assignees || [])]
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

  async listMessages(conversationId, userId, { page = 1, limit = 50, before } = {}) {
    await this.getConversation(conversationId, userId);

    const filter = { conversation: conversationId, type: 'chat' };
    if (before) {
      const pivot = await Message.findById(before).select('createdAt').lean();
      if (pivot?.createdAt) {
        filter.createdAt = { $lt: pivot.createdAt };
      }
    }

    const [data, total] = await Promise.all([
      populateMessage(
        Message.find(filter).sort({ createdAt: -1 }).limit(limit)
      ).lean(),
      Message.countDocuments({ conversation: conversationId, type: 'chat' }),
    ]);

    const hasMore = before
      ? data.length === limit
      : page * limit < total;

    return {
      data: data.reverse(),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
        hasMore,
      },
    };
  }

  validateAttachmentSizes(attachments = []) {
    for (const file of attachments) {
      const size = Number(file.size) || 0;
      const isImage = IMAGE_MIME_TYPES.includes(file.fileType);
      const max = isImage ? IMAGE_MAX_BYTES : DOCUMENT_MAX_BYTES;
      if (size > max) {
        const mb = Math.round(max / (1024 * 1024));
        throw ApiError.badRequest(
          `${isImage ? 'Images' : 'Documents'} must be ${mb} MB or smaller (${file.fileName || 'file'})`
        );
      }
    }
  }

  async sendChatMessage(
    conversationId,
    actorId,
    { body, mentions = [], shareLinks = [], attachments = [] }
  ) {
    const conversation = await Conversation.findById(conversationId);
    if (!conversation || !conversation.isActive) {
      throw ApiError.notFound('Conversation not found');
    }

    const isParticipant = conversation.participants.some(
      (p) => String(p) === String(actorId)
    );
    if (!isParticipant) throw ApiError.forbidden('You are not in this conversation');

    const text = String(body || '').trim();
    const files = (attachments || []).slice(0, MAX_FILES_PER_MESSAGE);
    const links = (shareLinks || []).slice(0, MAX_LINKS_PER_MESSAGE);

    if (!text && !files.length && !links.length) {
      throw ApiError.badRequest('Add a message, file, or link');
    }

    this.validateAttachmentSizes(files);

    const mentionIds = [...new Set((mentions || []).map(String))].filter((id) =>
      conversation.participants.some((p) => String(p) === id)
    );

    const message = await Message.create({
      from: actorId,
      conversation: conversationId,
      body: text || previewFromMessage({ text: '', attachments: files, shareLinks: links }),
      type: 'chat',
      subject: null,
      mentions: mentionIds,
      shareLinks: links.map((l) => ({
        url: l.url,
        label: l.label || '',
        kind: l.kind || 'external',
        refId: l.refId || null,
      })),
      attachments: files.map((f) => ({
        url: f.url,
        publicId: f.publicId || null,
        fileName: f.fileName || '',
        fileType: f.fileType || '',
        size: f.size || 0,
        uploadedBy: actorId,
        uploadedAt: new Date(),
      })),
      to:
        conversation.type === 'dm'
          ? conversation.participants.find((p) => String(p) !== String(actorId))
          : null,
      team: conversation.team || null,
      department: conversation.department || null,
    });

    conversation.lastMessageAt = new Date();
    conversation.lastMessagePreview = previewFromMessage({
      text,
      attachments: files,
      shareLinks: links,
    });
    conversation.lastMessageBy = actorId;

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
          notificationService
            .notify({
              recipient: recipientId,
              sender: actorId,
              type: mentionIds.includes(recipientId)
                ? NOTIFICATION_TYPES.MENTIONED
                : NOTIFICATION_TYPES.MESSAGE_RECEIVED,
              message: mentionIds.includes(recipientId)
                ? `Mentioned you in chat: ${text.slice(0, 80) || 'attachment'}`
                : `New chat message: ${text.slice(0, 80) || 'Shared a file'}`,
              entityType: 'Comment',
              entityId: message._id,
              emailToo: false,
            })
            .catch(() => {})
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
