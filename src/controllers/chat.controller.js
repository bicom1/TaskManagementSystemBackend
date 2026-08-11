const httpStatus = require('http-status-codes');
const chatService = require('../services/chat.service');

async function searchPeople(req, res) {
  const data = await chatService.searchPeople(req.user.id, {
    q: req.query.q,
    department: req.query.department,
    role: req.query.role,
    limit: Number(req.query.limit) || 30,
  });
  res.status(httpStatus.StatusCodes.OK).json({ success: true, data });
}

async function directory(req, res) {
  const data = await chatService.listDirectory();
  res.status(httpStatus.StatusCodes.OK).json({ success: true, data });
}

async function listConversations(req, res) {
  const page = Number(req.query.page) || 1;
  const limit = Math.min(Number(req.query.limit) || 40, 100);
  const result = await chatService.listConversations(req.user.id, { page, limit });
  res.status(httpStatus.StatusCodes.OK).json({ success: true, ...result });
}

async function getConversation(req, res) {
  const data = await chatService.getConversation(req.params.id, req.user.id);
  res.status(httpStatus.StatusCodes.OK).json({ success: true, data });
}

async function startDm(req, res) {
  const data = await chatService.getOrCreateDm(req.user.id, req.body.userId);
  res.status(httpStatus.StatusCodes.OK).json({ success: true, data });
}

async function startTeamChat(req, res) {
  const data = await chatService.getOrCreateTeamChat(req.user.id, req.body.teamId);
  res.status(httpStatus.StatusCodes.OK).json({ success: true, data });
}

async function startDepartmentChat(req, res) {
  const data = await chatService.getOrCreateDepartmentChat(
    req.user.id,
    req.body.departmentId
  );
  res.status(httpStatus.StatusCodes.OK).json({ success: true, data });
}

async function startTaskChat(req, res) {
  const data = await chatService.getOrCreateTaskChat(req.user.id, req.body.taskId);
  res.status(httpStatus.StatusCodes.OK).json({ success: true, data });
}

async function listMessages(req, res) {
  const page = Number(req.query.page) || 1;
  const limit = Math.min(Number(req.query.limit) || 50, 100);
  const result = await chatService.listMessages(req.params.id, req.user.id, {
    page,
    limit,
  });
  res.status(httpStatus.StatusCodes.OK).json({ success: true, ...result });
}

async function sendMessage(req, res) {
  const data = await chatService.sendChatMessage(req.params.id, req.user.id, req.body);
  res.status(httpStatus.StatusCodes.CREATED).json({ success: true, data });
}

async function markRead(req, res) {
  const data = await chatService.markConversationRead(req.params.id, req.user.id);
  res.status(httpStatus.StatusCodes.OK).json({ success: true, data });
}

module.exports = {
  searchPeople,
  directory,
  listConversations,
  getConversation,
  startDm,
  startTeamChat,
  startDepartmentChat,
  startTaskChat,
  listMessages,
  sendMessage,
  markRead,
};
