const userRepository = require('../repositories/user.repository');
const notificationService = require('./notification.service');
const { ROLES, normalizeRole } = require('../constants/roles.constant');
const { NOTIFICATION_SCOPES } = require('../constants/notification.constant');

/**
 * Notify every active Superadmin (in-app + optional email).
 * Skips the acting user and any IDs in excludeIds.
 * Always uses scope=system so members never see these events.
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
    {
      role: { $in: [ROLES.SUPERADMIN, 'super_admin', ROLES.SUPER_ADMIN] },
      isActive: true,
    },
    { page: 1, limit: 50 }
  );

  const skip = new Set([String(actorId || ''), ...excludeIds.map(String)]);
  await Promise.all(
    (result.data || [])
      .filter((admin) => {
        if (skip.has(String(admin._id))) return false;
        return normalizeRole(admin.role) === ROLES.SUPERADMIN;
      })
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
            scope: NOTIFICATION_SCOPES.SYSTEM,
          })
          .catch(() => {})
      )
  );
}

module.exports = { notifySuperAdmins };
