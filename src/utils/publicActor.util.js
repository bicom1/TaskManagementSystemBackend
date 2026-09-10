const { ROLES, normalizeRole } = require('../constants/roles.constant');

/**
 * Outward-facing actor label for emails / member-visible copy.
 * Never expose Super Admin name or email to non–superadmin recipients.
 */
function publicActorLabel(user, fallback = 'A teammate') {
  if (!user) return fallback;
  if (normalizeRole(user.role) === ROLES.SUPERADMIN) {
    return 'A workspace admin';
  }
  const name = String(user.name || '').trim();
  if (!name || name.includes('@')) return fallback;
  return name;
}

function isSuperAdminUser(user) {
  return Boolean(user && normalizeRole(user.role) === ROLES.SUPERADMIN);
}

module.exports = {
  publicActorLabel,
  isSuperAdminUser,
};
