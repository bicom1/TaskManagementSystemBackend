const mongoose = require('mongoose');
const ApiError = require('../utils/ApiError.util');

/**
 * Reject malformed Mongo ObjectIds with 400 instead of a CastError 500.
 * @param {string|string[]} paramNames - req.params keys to validate
 */
function validateObjectIdParam(paramNames = 'id') {
  const names = Array.isArray(paramNames) ? paramNames : [paramNames];
  return (req, _res, next) => {
    for (const name of names) {
      const value = req.params[name];
      if (value == null || value === '') {
        return next(ApiError.badRequest(`Missing ${name}`));
      }
      if (!mongoose.Types.ObjectId.isValid(String(value))) {
        return next(ApiError.badRequest(`Invalid ${name}`));
      }
    }
    next();
  };
}

/** Body field that must be a valid ObjectId when present */
function validateObjectIdBody(fieldNames = []) {
  const names = Array.isArray(fieldNames) ? fieldNames : [fieldNames];
  return (req, _res, next) => {
    for (const name of names) {
      const value = req.body?.[name];
      if (value == null || value === '') continue;
      if (!mongoose.Types.ObjectId.isValid(String(value))) {
        return next(ApiError.badRequest(`Invalid ${name}`));
      }
    }
    next();
  };
}

module.exports = { validateObjectIdParam, validateObjectIdBody };
