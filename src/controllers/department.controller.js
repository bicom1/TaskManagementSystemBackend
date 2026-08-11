const httpStatus = require('http-status-codes');
const departmentService = require('../services/department.service');

async function create(req, res) {
  const department = await departmentService.create(req.body, req.user.id);
  res.status(httpStatus.StatusCodes.CREATED).json({ success: true, data: department });
}

async function list(req, res) {
  const { page = 1, limit = 20 } = req.query;
  const result = await departmentService.list({ page: Number(page), limit: Number(limit) });
  res.status(httpStatus.StatusCodes.OK).json({ success: true, ...result });
}

async function getById(req, res) {
  const department = await departmentService.getById(req.params.id);
  res.status(httpStatus.StatusCodes.OK).json({ success: true, data: department });
}

async function update(req, res) {
  const department = await departmentService.update(req.params.id, req.body);
  res.status(httpStatus.StatusCodes.OK).json({ success: true, data: department });
}

async function deactivate(req, res) {
  await departmentService.deactivate(req.params.id);
  res.status(httpStatus.StatusCodes.NO_CONTENT).send();
}

module.exports = { create, list, getById, update, deactivate };
