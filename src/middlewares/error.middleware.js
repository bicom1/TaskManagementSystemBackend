const httpStatus = require('http-status-codes');
const env = require('../config/env');
const logger = require('../config/logger');
const ApiError = require('../utils/ApiError.util');

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  let error = err;

  // Mongo duplicate key → conflict
  if (err?.code === 11000 && !(err instanceof ApiError)) {
    const fields = Object.keys(err.keyPattern || err.keyValue || {});
    const field = fields[0] || 'field';
    const value = (err.keyValue || {})[field];
    const message =
      field === 'email'
        ? 'This email is already registered. Please log in using your existing account.'
        : field === 'googleId'
          ? 'This Google account is already linked to an existing account. Please log in.'
          : value
            ? `The ${field} "${value}" is already in use. Pick a different ${field}.`
            : `That ${field} is already in use. Pick a different ${field}.`;
    error = ApiError.conflict(message);
  } else if (err?.name === 'CastError' && !(err instanceof ApiError)) {
    // Malformed ObjectId / bad path param → 400 (not 500)
    const path = err.path || 'id';
    error = ApiError.badRequest(`Invalid ${path}`);
  } else if (err?.name === 'ValidationError' && !(err instanceof ApiError)) {
    const details = Object.values(err.errors || {})
      .map((e) => ({ field: e.path, message: e.message }))
      .filter((e) => e.message);
    error = ApiError.badRequest(details[0]?.message || 'Validation failed', details);
  } else if (!(error instanceof ApiError)) {
    const statusCode = error.statusCode || httpStatus.StatusCodes.INTERNAL_SERVER_ERROR;
    const message = error.message || 'Internal server error';
    error = new ApiError(statusCode, message, [], false);
  }

  if (!error.isOperational) {
    logger.error(err);
  } else {
    logger.warn(`${error.statusCode} - ${error.message}`);
  }

  res.status(error.statusCode).json({
    success: false,
    message: error.message,
    errors: error.errors,
    ...(env.NODE_ENV === 'development' && { stack: err.stack }),
  });
}

module.exports = errorHandler;
