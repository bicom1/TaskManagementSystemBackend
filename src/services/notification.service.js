const notificationRepository = require('../repositories/notification.repository');
const userRepository = require('../repositories/user.repository');
const { getIO } = require('../socket/socket');
const { enqueueEmail } = require('../jobs/queues/email.queue');
const { sendMail } = require('../emails/mailer.util');
const { notificationEmail } = require('../emails/templates');
const env = require('../config/env');

function buildActionUrl({ entityType, entityId, metadata = {} }) {
  const base = (env.CLIENT_URL || 'http://localhost:5173').replace(/\/$/, '');
  if (entityType === 'Project' && entityId) {
    return `${base}/projects/${entityId}`;
  }
  if (entityType === 'Task' && entityId) {
    const projectId = metadata.projectId;
    if (projectId) {
      return `${base}/projects/${projectId}?task=${entityId}`;
    }
    return `${base}/all-tasks`;
  }
  if (entityType === 'Comment' && metadata.projectId) {
    return `${base}/projects/${metadata.projectId}`;
  }
  return base;
}

async function deliverNotificationEmail({ to, recipientName, message, actionUrl, subject }) {
  const payload = {
    to,
    recipientName,
    message,
    actionUrl,
    subject: subject || 'You have a new update — BIWORKSPACE',
  };

  let queued = false;
  try {
    queued = await enqueueEmail('notification', payload);
  } catch {
    queued = false;
  }

  if (queued) return;

  try {
    await sendMail({
      to,
      subject: payload.subject,
      html: notificationEmail(payload),
    });
  } catch {
    // Best-effort — in-app notification already saved
  }
}

class NotificationService {
  /**
   * Creates a notification, pushes it over the recipient's socket room,
   * and (best-effort) sends an email. Never throws on delivery failure —
   * notification delivery should never break the caller's main action.
   */
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
  }) {
    const notification = await notificationRepository.create({
      recipient,
      sender,
      type,
      message,
      entityType,
      entityId,
    });

    try {
      getIO().to(`user:${recipient}`).emit('notification:new', notification);
    } catch {
      // Socket.IO not initialized (e.g. in a test/worker context) — skip silently
    }

    if (emailToo) {
      try {
        const user = await userRepository.findById(recipient);
        if (user?.email) {
          await deliverNotificationEmail({
            to: user.email,
            recipientName: user.name,
            message,
            actionUrl:
              actionUrl ||
              buildActionUrl({ entityType, entityId, metadata }),
            subject: emailSubject,
          });
        }
      } catch {
        // Email delivery failed — notification itself already succeeded
      }
    }

    return notification;
  }

  async list(userId, { page, limit }) {
    return notificationRepository.findPaginated({ recipient: userId }, { page, limit });
  }

  async markAllRead(userId) {
    return notificationRepository.markAllRead(userId);
  }

  async markOneRead(id, userId) {
    return notificationRepository.markOneRead(id, userId);
  }

  async unreadCount(userId) {
    return notificationRepository.unreadCount(userId);
  }
}

module.exports = new NotificationService();
