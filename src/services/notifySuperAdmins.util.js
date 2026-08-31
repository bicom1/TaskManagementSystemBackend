const userRepository = require('../repositories/user.repository');
const notificationService = require('./notification.service');
const { ROLES } = require('../constants/roles.constant');

/**
 * Notify every active Super Admin (email + in-app).
 * Skips the acting user if they are themselves a Super Admin.
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
}) {
  const result = await userRepository.findPaginated(
    { role: ROLES.SUPER_ADMIN, isActive: true },
    { page: 1, limit: 50 }
  );

  const actorKey = String(actorId || '');
  await Promise.all(
    (result.data || [])
      .filter((admin) => String(admin._id) !== actorKey)
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
