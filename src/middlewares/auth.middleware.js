const { verifyAccessToken } = require('../utils/jwt.util');
const ApiError = require('../utils/ApiError.util');
const { buildActorContext } = require('../services/policy.service');

function decodeBearer(req) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    throw ApiError.unauthorized('Access token missing');
  }
  const token = header.split(' ')[1];
  try {
    return verifyAccessToken(token);
  } catch {
    throw ApiError.unauthorized('Invalid or expired access token');
  }
}

/**
 * JWT authentication — sets req.user = { id, role }.
 */
function authenticate(req, res, next) {
  try {
    const decoded = decodeBearer(req);
    req.user = { id: decoded.id, role: decoded.role };
    next();
  } catch (err) {
    next(err);
  }
}


async function authenticateWithContext(req, res, next) {
  try {
    const decoded = decodeBearer(req);
    const context = await buildActorContext(decoded.id);
    req.user = {
      id: decoded.id,
      role: context.role,
      departmentId: context.departmentId,
      permissions: context.permissions,
      context,
    };
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = authenticate;
module.exports.authenticateWithContext = authenticateWithContext;
