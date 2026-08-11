const ApiError = require('../utils/ApiError.util');

/**
 * Role allowlist middleware (legacy / coarse checks).
 * Prefer requirePermission() from permission.middleware for new routes.
 * Usage: authorize('super_admin', 'dept_head')
 */
function authorize(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      throw ApiError.unauthorized('Authentication required');
    }
    if (!allowedRoles.includes(req.user.role)) {
      throw ApiError.forbidden('You do not have permission to perform this action');
    }
    next();
  };
}

module.exports = authorize;
