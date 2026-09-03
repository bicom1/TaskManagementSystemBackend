const httpStatus = require('http-status-codes');
const projectService = require('../services/project.service');

function actorFrom(req) {
  return req.user.context || req.user;
}

async function create(req, res) {
  const project = await projectService.create(req.body, actorFrom(req));
  res.status(httpStatus.StatusCodes.CREATED).json({ success: true, data: project });
}

async function list(req, res) {
  const { page = 1, limit = 200, team, status } = req.query;
  const result = await projectService.list(actorFrom(req), {
    page: Number(page),
    limit: Math.min(Number(limit) || 200, 500),
    team,
    status,
  });
  res.status(httpStatus.StatusCodes.OK).json({ success: true, ...result });
}

async function getById(req, res) {
  const project = await projectService.getById(req.params.id, actorFrom(req));
  res.status(httpStatus.StatusCodes.OK).json({ success: true, data: project });
}

async function update(req, res) {
  const project = await projectService.update(req.params.id, req.body, actorFrom(req));
  res.status(httpStatus.StatusCodes.OK).json({ success: true, data: project });
}

async function addMember(req, res) {
  const project = await projectService.addMember(
    req.params.id,
    req.body.userId,
    actorFrom(req)
  );
  res.status(httpStatus.StatusCodes.OK).json({ success: true, data: project });
}

async function remove(req, res) {
  const result = await projectService.delete(req.params.id, actorFrom(req));
  res.status(httpStatus.StatusCodes.OK).json({ success: true, data: result });
}

module.exports = { create, list, getById, update, addMember, remove };
