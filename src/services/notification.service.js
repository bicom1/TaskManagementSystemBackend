const notificationRepository = require('../repositories/notification.repository');
const userRepository = require('../repositories/user.repository');
const { getIO } = require('../socket/socket');
const { enqueueEmail } = require('../jobs/queues/email.queue');
const { sendMail } = require('../emails/mailer.util');
const { notificationEmail } = require('../emails/templates');
const logger = require('../config/logger');
const { getEmailAppUrl, ensureLiveEmailUrl } = require('../utils/clientUrl.util');

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

  // Direct send first — instant on live via Resend; queue is fallback only
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

    let socketPayload = notification;
    try {
      const full = await notificationRepository.findById(notification._id, {
        populate: [{ path: 'sender', select: 'name avatarUrl' }],
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
    return notificationRepository.findPaginated(
      { recipient: userId },
      {
        page,
        limit,
        populate: [{ path: 'sender', select: 'name avatarUrl' }],
      }
    );
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
