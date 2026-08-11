const httpStatus = require('http-status-codes');
const notificationService = require('../services/notification.service');

async function list(req, res) {
  const { page = 1, limit = 20 } = req.query;
  const result = await notificationService.list(req.user.id, { page: Number(page), limit: Number(limit) });
  res.status(httpStatus.StatusCodes.OK).json({ success: true, ...result });
}

async function unreadCount(req, res) {
  const count = await notificationService.unreadCount(req.user.id);
  res.status(httpStatus.StatusCodes.OK).json({ success: true, data: { count } });
}

async function markAllRead(req, res) {
  await notificationService.markAllRead(req.user.id);
  res.status(httpStatus.StatusCodes.OK).json({ success: true, message: 'All notifications marked as read' });
}

module.exports = { list, unreadCount, markAllRead };
