const ApiError = require('../utils/ApiError.util');
const { hasPermission, buildActorContext } = require('../services/policy.service');

/**
 * Ensure req.user has a full actor context (department, teams, permissions).
 */
async function loadActorContext(req, res, next) {
  try {
    if (!req.user?.id) {
      throw ApiError.unauthorized('Authentication required');
    }
    if (!req.user.context) {
      req.user.context = await buildActorContext(req.user.id);
      // Keep role in sync with DB (handles role changes without re-login for checks)
      req.user.role = req.user.context.role;
      req.user.departmentId = req.user.context.departmentId;
      req.user.permissions = req.user.context.permissions;
    }
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Require one or more permissions (OR). Uses actor context.
 * Usage: requirePermission(PERMISSIONS.USER_MANAGE)
 */
function requirePermission(...permissions) {
  return async (req, res, next) => {
    try {
      if (!req.user?.context) {
        req.user.context = await buildActorContext(req.user.id);
        req.user.role = req.user.context.role;
        req.user.permissions = req.user.context.permissions;
      }
      const actor = req.user.context;
      const ok = permissions.some((p) => hasPermission(actor, p));
      if (!ok) {
        throw ApiError.forbidden(
          `Missing required permission: ${permissions.join(' or ')}`
        );
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { loadActorContext, requirePermission };
