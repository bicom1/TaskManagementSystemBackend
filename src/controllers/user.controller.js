const httpStatus = require('http-status-codes');
const userService = require('../services/user.service');

async function list(req, res) {
  const page = Number(req.query.page) || 1;
  const limit = Math.min(Number(req.query.limit) || 50, 100);
  const actor = req.user.context || req.user;
  const result = await userService.list(actor, {
    page,
    limit,
    q: req.query.q,
    department: req.query.department,
    role: req.query.role,
    includeInactive: req.query.includeInactive,
  });
  res.status(httpStatus.StatusCodes.OK).json({ success: true, ...result });
}

async function me(req, res) {
  const user = await userService.me(req.user.id);
  res.status(httpStatus.StatusCodes.OK).json({ success: true, data: user });
}

async function getById(req, res) {
  const actor = req.user.context || req.user;
  const user = await userService.getById(actor, req.params.id);
  res.status(httpStatus.StatusCodes.OK).json({ success: true, data: user });
}

async function updateMe(req, res) {
  const user = await userService.updateMe(req.user.id, req.body);
  res.status(httpStatus.StatusCodes.OK).json({
    success: true,
    message: 'Profile updated',
    data: user,
  });
}

async function changePassword(req, res) {
  const result = await userService.changePassword(req.user.id, req.body);
  res.status(httpStatus.StatusCodes.OK).json({
    success: true,
    message: result.message,
  });
}

async function invite(req, res) {
  const actor = req.user.context || req.user;
  const result = await userService.invite(req.body, actor);
  res.status(httpStatus.StatusCodes.CREATED).json({
    success: true,
    message: 'Invitation sent',
    data: result,
  });
}

async function updateUser(req, res) {
  const actor = req.user.context || req.user;
  const user = await userService.updateUser(actor, req.params.id, req.body);
  res.status(httpStatus.StatusCodes.OK).json({
    success: true,
    message: 'User updated',
    data: user,
  });
}

async function deactivate(req, res) {
  const actor = req.user.context || req.user;
  const user = await userService.deactivate(actor, req.params.id);
  res.status(httpStatus.StatusCodes.OK).json({
    success: true,
    message: 'User deactivated',
    data: user,
  });
}

async function reactivate(req, res) {
  const actor = req.user.context || req.user;
  const user = await userService.reactivate(actor, req.params.id);
  res.status(httpStatus.StatusCodes.OK).json({
    success: true,
    message: 'User reactivated',
    data: user,
  });
}

async function remove(req, res) {
  const actor = req.user.context || req.user;
  const user = await userService.deleteUser(actor, req.params.id);
  res.status(httpStatus.StatusCodes.OK).json({
    success: true,
    message: 'User deleted',
    data: user,
  });
}

async function acceptInvite(req, res) {
  const user = await userService.acceptInvite(req.body);
  res.status(httpStatus.StatusCodes.OK).json({
    success: true,
    message: 'Invite accepted. You can now sign in.',
    data: user,
  });
}

async function previewInvite(req, res) {
  const user = await userService.previewInvite(req.query.token);
  res.status(httpStatus.StatusCodes.OK).json({ success: true, data: user });
}

module.exports = {
  list,
  me,
  getById,
  updateMe,
  changePassword,
  invite,
  updateUser,
  deactivate,
  reactivate,
  remove,
  acceptInvite,
  previewInvite,
};
