const httpStatus = require('http-status-codes');
const commentService = require('../services/comment.service');
const ApiError = require('../utils/ApiError.util');

function fileToAttachment(file, req) {
  const isCloudinary = Boolean(file.path && String(file.path).startsWith('http'));
  const url = isCloudinary
    ? file.path
    : `${req.protocol}://${req.get('host')}/uploads/${file.filename}`;

  return {
    url,
    publicId: file.filename || file.public_id || file.path,
    fileName: file.originalname,
    fileType: file.mimetype,
    uploadedBy: req.user.id,
  };
}

/** Multipart fields arrive as strings — normalize before zod validate. */
function normalizeCommentBody(req, _res, next) {
  if (typeof req.body?.mentions === 'string') {
    try {
      req.body.mentions = JSON.parse(req.body.mentions || '[]');
    } catch {
      req.body.mentions = [];
    }
  }
  if (typeof req.body?.links === 'string') {
    try {
      req.body.links = JSON.parse(req.body.links || '[]');
    } catch {
      req.body.links = [];
    }
  }
  if (req.body?.content == null) req.body.content = '';
  next();
}

async function create(req, res) {
  const uploaded = Array.isArray(req.files) ? req.files.map((f) => fileToAttachment(f, req)) : [];
  const existing = Array.isArray(req.body.attachments) ? req.body.attachments : [];
  const attachments = [...existing, ...uploaded];

  const content = (req.body.content || '').trim();
  const links = Array.isArray(req.body.links) ? req.body.links : [];

  if (!content && attachments.length === 0 && links.length === 0) {
    throw ApiError.badRequest('Add a message, link, or file to post a comment');
  }

  const comment = await commentService.create(
    {
      taskId: req.body.taskId,
      content,
      mentions: req.body.mentions || [],
      links,
      attachments,
    },
    req.user.id
  );

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

module.exports = { create, listByTask, update, remove, normalizeCommentBody };
