const httpStatus = require('http-status-codes');
const AuditLog = require('../models/auditLog.model');
const ActivityLog = require('../models/activityLog.model');

async function listAuditLogs(req, res) {
  const page = Number(req.query.page) || 1;
  const limit = Math.min(Number(req.query.limit) || 50, 100);
  const skip = (page - 1) * limit;

  const filter = {};
  if (req.query.user) filter.user = req.query.user;
  if (req.query.method) filter.method = req.query.method.toUpperCase();

  const [data, total] = await Promise.all([
    AuditLog.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('user', 'name email role')
      .lean(),
    AuditLog.countDocuments(filter),
  ]);

  res.status(httpStatus.StatusCodes.OK).json({
    success: true,
    data,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 },
  });
}

async function listActivity(req, res) {
  const page = Number(req.query.page) || 1;
  const limit = Math.min(Number(req.query.limit) || 50, 100);
  const skip = (page - 1) * limit;

  const filter = {};
  if (req.query.entityType) filter.entityType = req.query.entityType;
  if (req.query.entityId) filter.entityId = req.query.entityId;
  if (req.query.actor) filter.actor = req.query.actor;

  const [data, total] = await Promise.all([
    ActivityLog.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('actor', 'name email role avatarUrl')
      .lean(),
    ActivityLog.countDocuments(filter),
  ]);

  res.status(httpStatus.StatusCodes.OK).json({
    success: true,
    data,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 },
  });
}

module.exports = { listAuditLogs, listActivity };
