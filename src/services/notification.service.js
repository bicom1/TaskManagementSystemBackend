const notificationRepository = require('../repositories/notification.repository');
const userRepository = require('../repositories/user.repository');
const { getIO } = require('../socket/socket');
const { enqueueEmail } = require('../jobs/queues/email.queue');
const { sendMail } = require('../emails/mailer.util');
const { notificationEmail } = require('../emails/templates');
const logger = require('../config/logger');
const { getClientBaseUrl } = require('../utils/clientUrl.util');

function buildActionUrl({ entityType, entityId, metadata = {} }) {
  const base = getClientBaseUrl();
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
  } catch (err) {
    queued = false;
    logger.warn(`Notification email queue failed: ${err.message}`);
  }

  if (queued) {
    logger.debug(`Notification email queued → ${to} (${actionUrl})`);
    return;
  }

  try {
    await sendMail({
      to,
      subject: payload.subject,
      html: notificationEmail(payload),
    });
    logger.info(`Notification email sent (direct) → ${to} (${actionUrl})`);
  } catch (err) {
    logger.warn(`Notification email send failed → ${to}: ${err.message}`);
  }
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
      // Socket.IO not initialized — skip silently
    }

    if (emailToo) {
      try {
        const user = await userRepository.findById(recipient);
        if (user?.email) {
          const resolvedActionUrl =
            actionUrl || buildActionUrl({ entityType, entityId, metadata });
          await deliverNotificationEmail({
            to: user.email,
            recipientName: user.name,
            message,
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
