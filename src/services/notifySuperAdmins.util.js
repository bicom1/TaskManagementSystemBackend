const userRepository = require('../repositories/user.repository');
const notificationService = require('./notification.service');
const { ROLES } = require('../constants/roles.constant');

/**
 * Notify every active Super Admin (email + in-app).
 * Skips the acting user and any IDs in excludeIds (e.g. already notified attendees).
 */
async function notifySuperAdmins({
  actorId,
  type,
  message,
  entityType,
  entityId,
  emailSubject,
  metadata = {},
  emailToo = true,
  excludeIds = [],
}) {
  const result = await userRepository.findPaginated(
    { role: ROLES.SUPER_ADMIN, isActive: true },
    { page: 1, limit: 50 }
  );

  const skip = new Set([String(actorId || ''), ...excludeIds.map(String)]);
  await Promise.all(
    (result.data || [])
      .filter((admin) => !skip.has(String(admin._id)))
      .map((admin) =>
        notificationService
          .notify({
            recipient: admin._id,
            sender: actorId,
            type,
            message,
            entityType,
            entityId,
            emailToo,
            emailSubject: emailSubject || message,
            metadata,
          })
          .catch(() => {})
      )
  );
}

module.exports = { notifySuperAdmins };
