const httpStatus = require('http-status-codes');
const env = require('../config/env');
const logger = require('../config/logger'); // Winston logger, wired up in the core setup
const ApiError = require('../utils/ApiError.util');

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  let error = err;

  // Mongo duplicate key → conflict (do not leak raw driver text)
  if (err?.code === 11000 && !(err instanceof ApiError)) {
    const fields = Object.keys(err.keyPattern || err.keyValue || {});
    const field = fields[0] || 'field';
    const message =
      field === 'email'
        ? 'An account with this email already exists'
        : field === 'googleId'
          ? 'This Google account is already linked'
          : 'Duplicate value';
    error = ApiError.conflict(message);
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
