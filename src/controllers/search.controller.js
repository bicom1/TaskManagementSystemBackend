const httpStatus = require('http-status-codes');
const searchService = require('../services/search.service');

function actorFrom(req) {
  return req.user.context || req.user;
}

async function search(req, res) {
  const data = await searchService.search(actorFrom(req), {
    q: req.query.q,
    limit: req.query.limit,
  });
  res.status(httpStatus.StatusCodes.OK).json({ success: true, data });
}

module.exports = { search };
