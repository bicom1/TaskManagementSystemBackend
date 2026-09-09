const notificationRepository = require('../repositories/notification.repository');
const userRepository = require('../repositories/user.repository');
const { getIO } = require('../socket/socket');
const { enqueueEmail } = require('../jobs/queues/email.queue');
const { sendMail } = require('../emails/mailer.util');
const { notificationEmail } = require('../emails/templates');
const logger = require('../config/logger');
const { getEmailAppUrl, ensureLiveEmailUrl } = require('../utils/clientUrl.util');
const {
  NOTIFICATION_SCOPES,
  SYSTEM_ONLY_TYPES,
  NOTIFICATION_TYPES,
} = require('../constants/notification.constant');
const { ROLES, normalizeRole } = require('../constants/roles.constant');

/** Only these in-app events may also send email (invites use sendMail directly). */
const EMAIL_ALLOWED_TYPES = new Set([
  NOTIFICATION_TYPES.TASK_ASSIGNED,
  NOTIFICATION_TYPES.PROJECT_CREATED,
  NOTIFICATION_TYPES.PROJECT_MEMBER_ADDED,
  NOTIFICATION_TYPES.PROJECT_INVITE,
]);

function buildActionUrl({ entityType, entityId, metadata = {} }) {
  const base = getEmailAppUrl();
  let path = '';
  if (entityType === 'Project' && entityId) {
    path = `/projects/${entityId}`;
  } else if (entityType === 'Task' && entityId) {
    const projectId = metadata.projectId;
    path = projectId ? `/projects/${projectId}?task=${entityId}` : '/all-tasks';
  } else if (entityType === 'Comment' && metadata.projectId) {
    path = `/projects/${metadata.projectId}`;
  } else if (entityType === 'Meeting') {
    path = '/home/meetings';
  } else if (entityType === 'User') {
    path = '/teams/people';
  }

  return ensureLiveEmailUrl(`${base}${path}`);
}

async function deliverNotificationEmail({ to, recipientName, message, actionUrl, subject }) {
  const liveUrl = ensureLiveEmailUrl(actionUrl);
  const payload = {
    to,
    recipientName,
    message,
    actionUrl: liveUrl,
    subject: subject || 'You have a new update — BIWORKSPACE',
  };

  try {
    await sendMail({
      to,
      subject: payload.subject,
      html: notificationEmail(payload),
    });
    logger.info(`Notification email sent (direct) → ${to} (${liveUrl})`);
    return;
  } catch (directErr) {
    logger.warn(`Notification direct email failed → ${to}: ${directErr.message}`);
  }

  try {
    const queued = await enqueueEmail('notification', payload);
    if (queued) {
      logger.info(`Notification email queued (fallback) → ${to}`);
    }
  } catch (err) {
    logger.warn(`Notification email queue failed → ${to}: ${err.message}`);
  }
}

/** Members/Admins never see Superadmin system events in their inbox. */
function memberVisibleFilter() {
  return {
    scope: { $ne: NOTIFICATION_SCOPES.SYSTEM },
    type: { $nin: SYSTEM_ONLY_TYPES },
  };
}

class NotificationService {
  async notify({
    recipient,
    sender = null,
    type,
    message,
    entityType,
    entityId,
    emailToo = false,
    metadata = {},
    actionUrl = null,
    emailSubject = null,
    scope = NOTIFICATION_SCOPES.PERSONAL,
  }) {
    const resolvedScope = SYSTEM_ONLY_TYPES.includes(type)
      ? NOTIFICATION_SCOPES.SYSTEM
      : scope || NOTIFICATION_SCOPES.PERSONAL;

    // Never deliver system notifications to non-superadmin recipients
    if (resolvedScope === NOTIFICATION_SCOPES.SYSTEM) {
      try {
        const user = await userRepository.findById(recipient);
        if (!user || normalizeRole(user.role) !== ROLES.SUPERADMIN) {
          return null;
        }
      } catch {
        return null;
      }
    }

    const notification = await notificationRepository.create({
      recipient,
      sender,
      type,
      message,
      entityType,
      entityId,
      scope: resolvedScope,
    });

    let socketPayload = notification;
    try {
      const full = await notificationRepository.findById(notification._id, {
        populate: [{ path: 'sender', select: 'name avatarUrl role' }],
      });
      if (full) socketPayload = full;
    } catch {
      // use bare notification
    }

    try {
      getIO().to(`user:${String(recipient)}`).emit('notification:new', socketPayload);
    } catch {
      // Socket.IO not initialized — skip silently
    }

    if (emailToo && EMAIL_ALLOWED_TYPES.has(type)) {
      try {
        const user = await userRepository.findById(recipient);
        if (user?.email) {
          let emailMessage = message;
          // Prefer sender's display name in the email body when available
          try {
            if (sender && !/assigned you/i.test(String(message || ''))) {
              const senderUser = await userRepository.findById(sender);
              if (senderUser?.name) {
                emailMessage = `${senderUser.name}: ${message}`;
              }
            }
          } catch {
            /* keep original message */
          }
          const resolvedActionUrl =
            actionUrl || buildActionUrl({ entityType, entityId, metadata });
          await deliverNotificationEmail({
            to: user.email,
            recipientName: user.name,
            message: emailMessage,
            actionUrl: resolvedActionUrl,
            subject: emailSubject,
          });
        }
      } catch {
        // Email delivery failed — notification itself already succeeded
      }
    }

    return notification;
  }

  async list(userId, { page, limit }, viewerRole) {
    const filter = { recipient: userId };
    if (normalizeRole(viewerRole) !== ROLES.SUPERADMIN) {
      Object.assign(filter, memberVisibleFilter());
    }
    return notificationRepository.findPaginated(filter, {
      page,
      limit,
      populate: [{ path: 'sender', select: 'name avatarUrl role' }],
    });
  }

  async markAllRead(userId, viewerRole) {
    const filter = { recipient: userId, isRead: false };
    if (normalizeRole(viewerRole) !== ROLES.SUPERADMIN) {
      Object.assign(filter, memberVisibleFilter());
    }
    return notificationRepository.model.updateMany(filter, { isRead: true }).exec();
  }

  async markOneRead(id, userId) {
    return notificationRepository.markOneRead(id, userId);
  }

  async unreadCount(userId, viewerRole) {
    const filter = { recipient: userId, isRead: false };
    if (normalizeRole(viewerRole) !== ROLES.SUPERADMIN) {
      Object.assign(filter, memberVisibleFilter());
    }
    return notificationRepository.model.countDocuments(filter);
  }
}

module.exports = new NotificationService();
