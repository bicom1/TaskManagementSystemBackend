const httpStatus = require('http-status-codes');
const teamService = require('../services/team.service');

function actorFrom(req) {
  return req.user.context || req.user;
}

async function create(req, res) {
  const team = await teamService.create(req.body, actorFrom(req));
  res.status(httpStatus.StatusCodes.CREATED).json({ success: true, data: team });
}

async function list(req, res) {
  const { page = 1, limit = 50, department } = req.query;
  const result = await teamService.list(actorFrom(req), {
    page: Number(page),
    limit: Number(limit),
    department,
  });
  res.status(httpStatus.StatusCodes.OK).json({ success: true, ...result });
}

async function getById(req, res) {
  const team = await teamService.getById(req.params.id, actorFrom(req));
  res.status(httpStatus.StatusCodes.OK).json({ success: true, data: team });
}

async function update(req, res) {
  const team = await teamService.update(req.params.id, req.body, actorFrom(req));
  res.status(httpStatus.StatusCodes.OK).json({ success: true, data: team });
}

async function addMember(req, res) {
  const team = await teamService.addMember(
    req.params.id,
    req.body.userId,
    req.user.id,
    actorFrom(req)
  );
  res.status(httpStatus.StatusCodes.OK).json({ success: true, data: team });
}

async function removeMember(req, res) {
  const team = await teamService.removeMember(
    req.params.id,
    req.params.userId,
    actorFrom(req)
  );
  res.status(httpStatus.StatusCodes.OK).json({ success: true, data: team });
}

module.exports = { create, list, getById, update, addMember, removeMember };
