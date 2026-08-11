const httpStatus = require('http-status-codes');
const commentService = require('../services/comment.service');

async function create(req, res) {
  const comment = await commentService.create(req.body, req.user.id);
  res.status(httpStatus.StatusCodes.CREATED).json({ success: true, data: comment });
}

async function listByTask(req, res) {
  const comments = await commentService.listByTask(req.params.taskId);
  res.status(httpStatus.StatusCodes.OK).json({ success: true, data: comments });
}

async function update(req, res) {
  const comment = await commentService.update(req.params.id, req.body.content, req.user.id);
  res.status(httpStatus.StatusCodes.OK).json({ success: true, data: comment });
}

async function remove(req, res) {
  await commentService.delete(req.params.id, req.user.id, req.user.role);
  res.status(httpStatus.StatusCodes.NO_CONTENT).send();
}

module.exports = { create, listByTask, update, remove };
