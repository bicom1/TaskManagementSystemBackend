const httpStatus = require('http-status-codes');
const aiService = require('../services/ai.service');

async function chat(req, res) {
  const { message, messages, model } = req.body;
  const data = await aiService.chat(req.user.id, { message, messages, model });
  res.status(httpStatus.StatusCodes.OK).json({ success: true, data });
}

module.exports = { chat };
