const { Server } = require('socket.io');
const { verifyAccessToken } = require('../utils/jwt.util');
const userRepository = require('../repositories/user.repository');
const teamRepository = require('../repositories/team.repository');
const env = require('../config/env');
const logger = require('../config/logger');
const {
  isAllowedClientOrigin,
  PRODUCTION_APP_FALLBACK,
} = require('../utils/clientUrl.util');

let io;

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

  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) {
        logger.debug('Socket auth rejected: missing token');
        return next(new Error('Authentication required'));
      }
      const decoded = verifyAccessToken(token);
      socket.userId = decoded.id;
      next();
    } catch (err) {
      logger.debug(`Socket auth rejected: ${err.message || 'invalid token'}`);
      next(new Error('Invalid or expired token'));
    }
  });

  io.on('connection', async (socket) => {
    socket.join(`user:${socket.userId}`);
    logger.debug(`Socket connected: user:${socket.userId}`);

    try {
      const user = await userRepository.findById(socket.userId);
      if (user?.department) {
        socket.join(`department:${user.department}`);
      }

      const teams = await teamRepository.findPaginated(
        {
          $or: [{ lead: socket.userId }, { members: socket.userId }],
        },
        { page: 1, limit: 50 }
      );
      for (const team of teams.data || []) {
        socket.join(`team:${team._id}`);
      }
    } catch (err) {
      logger.warn(`Socket room join failed for user:${socket.userId}: ${err.message}`);
    }

    socket.on('project:join', (projectId) => socket.join(`project:${projectId}`));
    socket.on('project:leave', (projectId) => socket.leave(`project:${projectId}`));
    socket.on('team:join', (teamId) => socket.join(`team:${teamId}`));
    socket.on('team:leave', (teamId) => socket.leave(`team:${teamId}`));
    socket.on('department:join', (departmentId) => socket.join(`department:${departmentId}`));
    socket.on('department:leave', (departmentId) => socket.leave(`department:${departmentId}`));

    socket.on('conversation:join', (conversationId) => {
      if (conversationId) socket.join(`conversation:${conversationId}`);
    });
    socket.on('conversation:leave', (conversationId) => {
      if (conversationId) socket.leave(`conversation:${conversationId}`);
    });

    socket.on('message:typing', ({ to, team, department, conversationId }) => {
      const payload = { from: socket.userId, conversationId: conversationId || null };
      if (conversationId) {
        socket.to(`conversation:${conversationId}`).emit('message:typing', payload);
      } else if (to) {
        io.to(`user:${to}`).emit('message:typing', payload);
      } else if (team) {
        socket.to(`team:${team}`).emit('message:typing', { ...payload, team });
      } else if (department) {
        socket.to(`department:${department}`).emit('message:typing', { ...payload, department });
      }
    });

    socket.on('disconnect', () => {
      logger.debug(`Socket disconnected: user:${socket.userId}`);
    });
  });

  return io;
}

function getIO() {
  if (!io) throw new Error('Socket.IO not initialized — call initSocket first');
  return io;
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
}

/** Live task board / list updates inside a Space + notify assignees personally */
function emitTaskEvent(event, task, projectId) {
  if (!io || !task) return;
  const pid = String(projectId || task.project?._id || task.project);
  if (!pid) return;
  const payload = typeof task.toObject === 'function' ? task.toObject() : task;
  io.to(`project:${pid}`).emit(event, payload);
  io.to(`project:${pid}`).emit('task:changed', { event, task: payload, projectId: pid });
  // Sidebar open-task counts for everyone watching the org
  io.emit('projects:counts', { projectId: pid });

  // Push to each assignee's personal room so "Assigned to me" updates live
  const assigneeIds = (payload.assignees || [])
    .map((a) => String(a?._id || a))
    .filter(Boolean);
  for (const uid of assigneeIds) {
    io.to(`user:${uid}`).emit('task:changed', { event, task: payload, projectId: pid });
    io.to(`user:${uid}`).emit('task:assigned', { task: payload, projectId: pid });
  }
}

module.exports = {
  initSocket,
  getIO,
  emitMessage,
  emitChatMessage,
  emitConversationUpdated,
  emitProjectEvent,
  emitTaskEvent,
};
