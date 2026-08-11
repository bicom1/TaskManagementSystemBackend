const httpStatus = require('http-status-codes');
const messageService = require('../services/message.service');

async function send(req, res) {
  const data = await messageService.send(req.body, req.user.id);
  res.status(httpStatus.StatusCodes.CREATED).json({ success: true, data });
}

async function inbox(req, res) {
  const page = Number(req.query.page) || 1;
  const limit = Math.min(Number(req.query.limit) || 30, 100);
  const result = await messageService.inbox(req.user.id, { page, limit });
  res.status(httpStatus.StatusCodes.OK).json({ success: true, ...result });
}

async function markRead(req, res) {
  const data = await messageService.markRead(req.params.id, req.user.id);
  res.status(httpStatus.StatusCodes.OK).json({ success: true, data });
}

async function markAllRead(req, res) {
  await messageService.markAllRead(req.user.id);
  res.status(httpStatus.StatusCodes.OK).json({ success: true, message: 'All messages marked read' });
}

async function createTask(req, res) {
  const data = await messageService.createTaskFromMessage(
    req.params.id,
    req.body,
    req.user
  );
  res.status(httpStatus.StatusCodes.CREATED).json({ success: true, data });
}

module.exports = { send, inbox, markRead, markAllRead, createTask };

