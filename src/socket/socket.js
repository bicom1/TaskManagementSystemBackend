const { Server } = require('socket.io');
const { verifyAccessToken } = require('../utils/jwt.util');
const userRepository = require('../repositories/user.repository');
const teamRepository = require('../repositories/team.repository');
const Conversation = require('../models/conversation.model');
const Project = require('../models/project.model');
const Team = require('../models/team.model');
const Department = require('../models/department.model');
const env = require('../config/env');
const logger = require('../config/logger');
const { ROLES } = require('../constants/roles.constant');
const {
  isAllowedClientOrigin,
  PRODUCTION_APP_FALLBACK,
} = require('../utils/clientUrl.util');

let io;

/** userId -> { sockets: Set<socketId>, lastSeen: Date|null, name: string } */
const presenceByUser = new Map();

function allowedOrigin(origin) {
  const allowed = new Set([
    env.CLIENT_URL,
    PRODUCTION_APP_FALLBACK,
    'http://localhost:5173',
    'http://127.0.0.1:5173',
  ]);
  const isVercelPreview =
    typeof origin === 'string' &&
    /^https:\/\/task-management-system-frontend[\w-]*\.vercel\.app$/i.test(origin);
  return !origin || allowed.has(origin) || isVercelPreview || isAllowedClientOrigin(origin);
}

function presencePayload(userId, entryOverride) {
  const entry = entryOverride || presenceByUser.get(String(userId));
  if (entry?.sockets?.size) {
    return {
      userId: String(userId),
      status: 'online',
      lastSeen: null,
      name: entry.name || null,
    };
  }
  return {
    userId: String(userId),
    status: 'offline',
    lastSeen: entry?.lastSeen || null,
    name: entry?.name || null,
  };
}

function broadcastPresence(userId) {
  if (!io) return;
  io.emit('presence:update', presencePayload(userId));
}

async function markUserSeen(userId) {
  try {
    await userRepository.updateById(userId, { lastSeenAt: new Date() });
  } catch {
    /* non-fatal */
  }
}

async function assertCanJoinConversation(userId, conversationId, role) {
  if (role === ROLES.SUPER_ADMIN) return true;
  const conversation = await Conversation.findById(conversationId)
    .select('participants isActive')
    .lean();
  if (!conversation || conversation.isActive === false) return false;
  return (conversation.participants || []).some((p) => String(p) === String(userId));
}

async function assertCanJoinProject(userId, projectId, role) {
  if (role === ROLES.SUPER_ADMIN) return true;
  const project = await Project.findById(projectId)
    .select('owner members team isPrivate')
    .lean();
  if (!project) return false;
  const uid = String(userId);
  if (String(project.owner) === uid) return true;
  if ((project.members || []).some((m) => String(m) === uid)) return true;
  if (project.team) {
    const team = await Team.findById(project.team).select('lead members').lean();
    if (team && (String(team.lead) === uid || (team.members || []).some((m) => String(m) === uid))) {
      return true;
    }
  }
  // Non-private projects are visible workspace-wide
  return project.isPrivate !== true;
}

async function assertCanJoinTeam(userId, teamId, role) {
  if (role === ROLES.SUPER_ADMIN) return true;
  const team = await Team.findById(teamId).select('lead members').lean();
  if (!team) return false;
  const uid = String(userId);
  return String(team.lead) === uid || (team.members || []).some((m) => String(m) === uid);
}

async function assertCanJoinDepartment(userId, departmentId, role) {
  if (role === ROLES.SUPER_ADMIN) return true;
  const user = await userRepository.findById(userId);
  if (user?.department && String(user.department) === String(departmentId)) return true;
  const dept = await Department.findById(departmentId).select('head').lean();
  return dept && String(dept.head) === String(userId);
}

function initSocket(httpServer) {
  io = new Server(httpServer, {
    cors: {
      origin: (origin, cb) => cb(null, allowedOrigin(origin)),
      credentials: true,
    },
    pingInterval: 25_000,
    pingTimeout: 20_000,
    maxHttpBufferSize: 1e6,
    transports: ['websocket', 'polling'],
  });

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) {
        logger.debug('Socket auth rejected: missing token');
        return next(new Error('Authentication required'));
      }
      const decoded = verifyAccessToken(token);
      const user = await userRepository.findById(decoded.id);
      if (!user || user.isActive === false) {
        return next(new Error('Account is deactivated'));
      }
      socket.userId = String(user._id);
      socket.userRole = user.role;
      socket.userName = user.name;
      next();
    } catch (err) {
      logger.debug(`Socket auth rejected: ${err.message || 'invalid token'}`);
      next(new Error('Invalid or expired token'));
    }
  });

  io.on('connection', async (socket) => {
    const userId = String(socket.userId);
    socket.join(`user:${userId}`);
    logger.debug(`Socket connected: user:${userId}`);

    const existing = presenceByUser.get(userId) || {
      sockets: new Set(),
      lastSeen: null,
      name: socket.userName,
    };
    const wasOffline = existing.sockets.size === 0;
    existing.sockets.add(socket.id);
    existing.name = socket.userName || existing.name;
    presenceByUser.set(userId, existing);
    if (wasOffline) broadcastPresence(userId);

    // Snapshot of currently online users (compact)
    const onlineSnapshot = [];
    for (const [uid, entry] of presenceByUser.entries()) {
      if (entry.sockets.size > 0) {
        onlineSnapshot.push({
          userId: uid,
          status: 'online',
          lastSeen: null,
          name: entry.name || null,
        });
      }
    }
    socket.emit('presence:snapshot', { online: onlineSnapshot });

    try {
      const user = await userRepository.findById(userId);
      if (user?.department) {
        socket.join(`department:${user.department}`);
      }

      const teams = await teamRepository.findPaginated(
        {
          $or: [{ lead: userId }, { members: userId }],
        },
        { page: 1, limit: 50 }
      );
      for (const team of teams.data || []) {
        socket.join(`team:${team._id}`);
      }
    } catch (err) {
      logger.warn(`Socket room join failed for user:${userId}: ${err.message}`);
    }

    socket.on('presence:ping', () => {
      socket.emit('presence:pong', { at: Date.now() });
    });

    socket.on('presence:query', async (userIds = []) => {
      const ids = Array.isArray(userIds) ? userIds.map(String).slice(0, 200) : [];
      const rows = [];
      for (const id of ids) {
        const live = presenceByUser.get(id);
        if (live?.sockets?.size) {
          rows.push(presencePayload(id, live));
          continue;
        }
        let lastSeen = live?.lastSeen || null;
        let name = live?.name || null;
        if (!lastSeen) {
          try {
            const u = await userRepository.findById(id);
            if (u) {
              lastSeen = u.lastSeenAt || u.lastLoginAt || null;
              name = u.name || name;
            }
          } catch {
            /* ignore */
          }
        }
        rows.push({
          userId: id,
          status: 'offline',
          lastSeen,
          name,
        });
      }
      socket.emit('presence:bulk', rows);
    });

    socket.on('project:join', async (projectId, ack) => {
      try {
        const ok = await assertCanJoinProject(userId, projectId, socket.userRole);
        if (!ok) {
          if (typeof ack === 'function') ack({ ok: false });
          return;
        }
        socket.join(`project:${projectId}`);
        if (typeof ack === 'function') ack({ ok: true });
      } catch {
        if (typeof ack === 'function') ack({ ok: false });
      }
    });
    socket.on('project:leave', (projectId) => socket.leave(`project:${projectId}`));

    socket.on('team:join', async (teamId, ack) => {
      try {
        const ok = await assertCanJoinTeam(userId, teamId, socket.userRole);
        if (!ok) {
          if (typeof ack === 'function') ack({ ok: false });
          return;
        }
        socket.join(`team:${teamId}`);
        if (typeof ack === 'function') ack({ ok: true });
      } catch {
        if (typeof ack === 'function') ack({ ok: false });
      }
    });
    socket.on('team:leave', (teamId) => socket.leave(`team:${teamId}`));

    socket.on('department:join', async (departmentId, ack) => {
      try {
        const ok = await assertCanJoinDepartment(userId, departmentId, socket.userRole);
        if (!ok) {
          if (typeof ack === 'function') ack({ ok: false });
          return;
        }
        socket.join(`department:${departmentId}`);
        if (typeof ack === 'function') ack({ ok: true });
      } catch {
        if (typeof ack === 'function') ack({ ok: false });
      }
    });
    socket.on('department:leave', (departmentId) => socket.leave(`department:${departmentId}`));

    socket.on('conversation:join', async (conversationId, ack) => {
      try {
        if (!conversationId) {
          if (typeof ack === 'function') ack({ ok: false });
          return;
        }
        const ok = await assertCanJoinConversation(userId, conversationId, socket.userRole);
        if (!ok) {
          if (typeof ack === 'function') ack({ ok: false });
          return;
        }
        socket.join(`conversation:${conversationId}`);
        if (typeof ack === 'function') ack({ ok: true });
      } catch {
        if (typeof ack === 'function') ack({ ok: false });
      }
    });
    socket.on('conversation:leave', (conversationId) => {
      if (conversationId) socket.leave(`conversation:${conversationId}`);
    });

    socket.on('message:typing', async ({ to, team, department, conversationId }) => {
      const payload = { from: userId, conversationId: conversationId || null };
      if (conversationId) {
        const ok = await assertCanJoinConversation(userId, conversationId, socket.userRole);
        if (!ok) return;
        socket.to(`conversation:${conversationId}`).emit('message:typing', payload);
      } else if (to) {
        io.to(`user:${to}`).emit('message:typing', payload);
      } else if (team) {
        const ok = await assertCanJoinTeam(userId, team, socket.userRole);
        if (!ok) return;
        socket.to(`team:${team}`).emit('message:typing', { ...payload, team });
      } else if (department) {
        const ok = await assertCanJoinDepartment(userId, department, socket.userRole);
        if (!ok) return;
        socket.to(`department:${department}`).emit('message:typing', {
          ...payload,
          department,
        });
      }
    });

    socket.on('disconnect', async () => {
      logger.debug(`Socket disconnected: user:${userId}`);
      const entry = presenceByUser.get(userId);
      if (!entry) return;
      entry.sockets.delete(socket.id);
      if (entry.sockets.size === 0) {
        entry.lastSeen = new Date();
        presenceByUser.set(userId, entry);
        await markUserSeen(userId);
        broadcastPresence(userId);
      }
    });
  });

  return io;
}

function getIO() {
  if (!io) throw new Error('Socket.IO not initialized — call initSocket first');
  return io;
}

/**
 * Immediately invalidate an active session (deactivate / delete).
 * Emits a client toast payload then disconnects all sockets for that user.
 */
function forceDisconnectUser(userId, { reason = 'session_revoked', message, name } = {}) {
  if (!io || !userId) return;
  const uid = String(userId);
  io.to(`user:${uid}`).emit('session:revoked', {
    reason,
    message:
      message ||
      (reason === 'deleted'
        ? 'Your account has been deleted. Please contact your administrator.'
        : 'Your account has been deactivated. Please contact your administrator.'),
    name: name || null,
  });
  try {
    io.in(`user:${uid}`).disconnectSockets(true);
  } catch (err) {
    logger.warn(`forceDisconnectUser failed for ${uid}: ${err.message}`);
  }
  presenceByUser.delete(uid);
  broadcastPresence(uid);
}

/** Workspace-wide user lifecycle events (people lists, chat directory). */
function emitUserEvent(event, payload) {
  if (!io || !payload) return;
  const data = typeof payload.toObject === 'function' ? payload.toObject() : payload;
  io.emit(event, data);
  io.emit('user:changed', { event, user: data });
}

function emitMessage(message, recipientIds = []) {
  if (!io) return;

  const payload = {
    _id: message._id,
    from: message.from,
    to: message.to,
    department: message.department,
    team: message.team,
    conversation: message.conversation,
    subject: message.subject,
    body: message.body,
    type: message.type,
    mentions: message.mentions,
    shareLinks: message.shareLinks,
    isRead: message.isRead,
    createdAt: message.createdAt,
  };

  const uniqueRecipients = [...new Set(recipientIds.map(String))];
  for (const recipientId of uniqueRecipients) {
    io.to(`user:${recipientId}`).emit('message:new', payload);
  }

  if (message.team) {
    const teamId = message.team._id ?? message.team;
    io.to(`team:${teamId}`).emit('message:new', payload);
  }
  if (message.department) {
    const deptId = message.department._id ?? message.department;
    io.to(`department:${deptId}`).emit('message:new', payload);
  }
}

/** Real-time chat message into conversation room + each participant */
function emitChatMessage(message, participantIds = [], conversationId) {
  if (!io) return;

  const payload = {
    _id: message._id,
    from: message.from,
    to: message.to,
    conversation: conversationId || message.conversation,
    body: message.body,
    type: 'chat',
    mentions: message.mentions || [],
    shareLinks: message.shareLinks || [],
    attachments: message.attachments || [],
    readBy: message.readBy || [],
    deliveredTo: message.deliveredTo || [],
    createdAt: message.createdAt,
  };

  if (conversationId) {
    io.to(`conversation:${conversationId}`).emit('chat:message', payload);
  }

  const unique = [...new Set(participantIds.map(String))];
  for (const uid of unique) {
    io.to(`user:${uid}`).emit('chat:message', payload);
    io.to(`user:${uid}`).emit('message:new', { ...payload, subject: 'Chat' });
  }
}

function emitConversationUpdated(conversation, participantIds = []) {
  if (!io) return;
  const unique = [...new Set(participantIds.map(String))];
  for (const uid of unique) {
    io.to(`user:${uid}`).emit('chat:conversation', conversation);
  }
}

/** Live Space / project updates for sidebar + open boards */
function emitProjectEvent(event, project, { teamId, ownerId, memberIds = [] } = {}) {
  if (!io || !project) return;
  const projectId = String(project._id || project.id);
  const payload = typeof project.toObject === 'function' ? project.toObject() : project;

  io.to(`project:${projectId}`).emit(event, payload);

  if (teamId) io.to(`team:${String(teamId)}`).emit(event, payload);
  if (ownerId) io.to(`user:${String(ownerId)}`).emit(event, payload);
  for (const uid of memberIds || []) {
    if (uid) io.to(`user:${String(uid)}`).emit(event, payload);
  }
  // Sidebar / All Projects for everyone with a live connection
  io.emit(event, payload);
}

/** Live task board / list updates inside a Space + notify assignees personally */
function emitTaskEvent(event, task, projectId) {
  if (!io || !task) return;
  const pid = String(projectId || task.project?._id || task.project);
  if (!pid) return;
  const payload = typeof task.toObject === 'function' ? task.toObject() : task;
  io.to(`project:${pid}`).emit(event, payload);
  io.to(`project:${pid}`).emit('task:changed', { event, task: payload, projectId: pid });
  io.emit('projects:counts', { projectId: pid });
  // Home / My Tasks listeners that are not in the project room
  io.emit('task:changed', { event, task: payload, projectId: pid });

  const assigneeIds = (payload.assignees || [])
    .map((a) => String(a?._id || a))
    .filter(Boolean);
  for (const uid of assigneeIds) {
    io.to(`user:${uid}`).emit('task:changed', { event, task: payload, projectId: pid });
    io.to(`user:${uid}`).emit('task:assigned', { task: payload, projectId: pid });
  }
}

function getPresenceMap() {
  const out = {};
  for (const [uid, entry] of presenceByUser.entries()) {
    out[uid] = presencePayload(uid);
  }
  return out;
}

module.exports = {
  initSocket,
  getIO,
  emitMessage,
  emitChatMessage,
  emitConversationUpdated,
  emitProjectEvent,
  emitTaskEvent,
  emitUserEvent,
  forceDisconnectUser,
  getPresenceMap,
  presencePayload,
};
