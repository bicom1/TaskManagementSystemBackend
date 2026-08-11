const httpStatus = require('http-status-codes');
const taskService = require('../services/task.service');
const activityService = require('../services/activity.service');
const taskRepository = require('../repositories/task.repository');
const policy = require('../services/policy.service');
const ApiError = require('../utils/ApiError.util');

function actorFrom(req) {
  return req.user.context || req.user;
}

async function create(req, res) {
  const task = await taskService.create(req.body, actorFrom(req));
  res.status(httpStatus.StatusCodes.CREATED).json({ success: true, data: task });
}

async function getBoard(req, res) {
  const board = await taskService.getBoard(req.params.projectId, actorFrom(req));
  res.status(httpStatus.StatusCodes.OK).json({ success: true, data: board });
}

async function getById(req, res) {
  const task = await taskService.getById(req.params.id, actorFrom(req));
  res.status(httpStatus.StatusCodes.OK).json({ success: true, data: task });
}

async function getSubtasks(req, res) {
  const subtasks = await taskService.getSubtasks(req.params.id, actorFrom(req));
  res.status(httpStatus.StatusCodes.OK).json({ success: true, data: subtasks });
}

async function getPendingApprovals(req, res) {
  const data = await taskService.getPendingApprovals(actorFrom(req));
  res.status(httpStatus.StatusCodes.OK).json({ success: true, data });
}

async function approve(req, res) {
  const task = await taskService.approve(req.params.id, actorFrom(req));
  res.status(httpStatus.StatusCodes.OK).json({ success: true, data: task });
}

async function reject(req, res) {
  const task = await taskService.reject(req.params.id, actorFrom(req), req.body.reason);
  res.status(httpStatus.StatusCodes.OK).json({ success: true, data: task });
}

async function update(req, res) {
  const task = await taskService.update(req.params.id, req.body, actorFrom(req));
  res.status(httpStatus.StatusCodes.OK).json({ success: true, data: task });
}

async function move(req, res) {
  const task = await taskService.moveToColumn(req.params.id, req.body, actorFrom(req));
  res.status(httpStatus.StatusCodes.OK).json({ success: true, data: task });
}

async function remove(req, res) {
  await taskService.delete(req.params.id, actorFrom(req));
  res.status(httpStatus.StatusCodes.NO_CONTENT).send();
}

async function getActivity(req, res) {
  await taskService.getById(req.params.id, actorFrom(req));
  const timeline = await activityService.getTimeline('Task', req.params.id);
  res.status(httpStatus.StatusCodes.OK).json({ success: true, data: timeline });
}

async function uploadAttachment(req, res) {
  if (!req.file) throw ApiError.badRequest('No file uploaded');

  const actor = actorFrom(req);
  const task = await taskService.getById(req.params.id, actor);
  policy.assertTaskManage(actor, task, task.project);

  const isCloudinary = Boolean(req.file.path && String(req.file.path).startsWith('http'));
  const url = isCloudinary
    ? req.file.path
    : `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;

  const doc = await taskRepository.findById(req.params.id);
  doc.attachments.push({
    url,
    publicId: req.file.filename || req.file.public_id || req.file.path,
    fileName: req.file.originalname,
    fileType: req.file.mimetype,
    uploadedBy: req.user.id,
  });
  await doc.save();

  res.status(httpStatus.StatusCodes.CREATED).json({ success: true, data: doc.attachments });
}

async function advance(req, res) {
  const task = await taskService.advance(req.params.id, actorFrom(req));
  res.status(httpStatus.StatusCodes.OK).json({ success: true, data: task });
}

module.exports = {
  create,
  getBoard,
  getById,
  getSubtasks,
  getPendingApprovals,
  approve,
  reject,
  update,
  move,
  advance,
  remove,
  getActivity,
  uploadAttachment,
};
