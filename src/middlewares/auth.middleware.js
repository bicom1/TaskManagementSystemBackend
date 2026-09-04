const { verifyAccessToken } = require('../utils/jwt.util');
const ApiError = require('../utils/ApiError.util');
const { buildActorContext } = require('../services/policy.service');
const userRepository = require('../repositories/user.repository');

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
 * Rejects deactivated accounts even if the access token is still valid.
 */
async function authenticate(req, res, next) {
  try {
    const decoded = decodeBearer(req);
    const user = await userRepository.findById(decoded.id);
    if (!user || user.isActive === false) {
      throw ApiError.unauthorized('Your account has been deactivated');
    }
    req.user = { id: String(user._id), role: user.role };
    next();
  } catch (err) {
    next(err);
  }
}

async function authenticateWithContext(req, res, next) {
  try {
    const decoded = decodeBearer(req);
    const user = await userRepository.findById(decoded.id);
    if (!user || user.isActive === false) {
      throw ApiError.unauthorized('Your account has been deactivated');
    }
    const context = await buildActorContext(decoded.id);
    req.user = {
      id: String(user._id),
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
