const httpStatus = require('http-status-codes');
const chatService = require('../services/chat.service');
const ApiError = require('../utils/ApiError.util');
const {
  MAX_FILES_PER_MESSAGE,
  IMAGE_MAX_BYTES,
  DOCUMENT_MAX_BYTES,
  IMAGE_MIME_TYPES,
} = require('../constants/chat.constant');

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
    size: file.size || 0,
    uploadedBy: req.user.id,
  };
}

/** Multipart fields arrive as strings — normalize before zod validate. */
function normalizeChatMessageBody(req, _res, next) {
  if (typeof req.body?.mentions === 'string') {
    try {
      req.body.mentions = JSON.parse(req.body.mentions || '[]');
    } catch {
      req.body.mentions = [];
    }
  }
  if (typeof req.body?.shareLinks === 'string') {
    try {
      req.body.shareLinks = JSON.parse(req.body.shareLinks || '[]');
    } catch {
      req.body.shareLinks = [];
    }
  }
  if (req.body?.body == null) req.body.body = '';
  next();
}

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
  const data = await chatService.listDirectory(req.user.id);
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
    before: req.query.before,
  });
  res.status(httpStatus.StatusCodes.OK).json({ success: true, ...result });
}

async function sendMessage(req, res) {
  const uploaded = Array.isArray(req.files)
    ? req.files.map((f) => fileToAttachment(f, req))
    : [];

  if (uploaded.length > MAX_FILES_PER_MESSAGE) {
    throw ApiError.badRequest(`Maximum ${MAX_FILES_PER_MESSAGE} files per message`);
  }

  for (const file of uploaded) {
    const isImage = IMAGE_MIME_TYPES.includes(file.fileType);
    const max = isImage ? IMAGE_MAX_BYTES : DOCUMENT_MAX_BYTES;
    if (file.size > max) {
      const mb = Math.round(max / (1024 * 1024));
      throw ApiError.badRequest(
        `${isImage ? 'Images' : 'Documents'} must be ${mb} MB or smaller`
      );
    }
  }

  const data = await chatService.sendChatMessage(req.params.id, req.user.id, {
    body: req.body.body,
    mentions: req.body.mentions || [],
    shareLinks: req.body.shareLinks || [],
    attachments: uploaded,
  });
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
  normalizeChatMessageBody,
};
