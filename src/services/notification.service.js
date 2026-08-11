const notificationRepository = require('../repositories/notification.repository');
const userRepository = require('../repositories/user.repository');
const { getIO } = require('../socket/socket');
const { enqueueEmail } = require('../jobs/queues/email.queue');
const env = require('../config/env');

class NotificationService {
  /**
   * Creates a notification, pushes it over the recipient's socket room,
   * and (best-effort) queues an email. Never throws on delivery failure —
   * notification delivery should never break the caller's main action.
   */
  async notify({ recipient, sender = null, type, message, entityType, entityId, emailToo = false }) {
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
        if (user) {
          await enqueueEmail('notification', {
            to: user.email,
            recipientName: user.name,
            message,
            actionUrl: `${env.CLIENT_URL}/${entityType.toLowerCase()}s/${entityId}`,
          });
        }
      } catch {
        // Email queue unavailable — notification itself already succeeded
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

  async unreadCount(userId) {
    return notificationRepository.unreadCount(userId);
  }
}

module.exports = new NotificationService();
