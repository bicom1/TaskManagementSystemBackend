const httpStatus = require('http-status-codes');
const homeService = require('../services/home.service');

async function overview(req, res) {
  const data = await homeService.getOverview(req.user.id);
  res.status(httpStatus.StatusCodes.OK).json({ success: true, data });
}

async function updatePreferences(req, res) {
  const data = await homeService.updatePreferences(req.user.id, req.body);
  res.status(httpStatus.StatusCodes.OK).json({ success: true, data });
}

async function myTasks(req, res) {
  const view = req.query.view || 'assigned';
  const data = await homeService.listMyTasks(req.user.id, { view });
  res.status(httpStatus.StatusCodes.OK).json({ success: true, data });
}

async function addPersonal(req, res) {
  const data = await homeService.addToPersonalList(req.user.id, req.body.taskId);
  res.status(httpStatus.StatusCodes.OK).json({ success: true, data });
}

async function removePersonal(req, res) {
  const data = await homeService.removeFromPersonalList(req.user.id, req.params.taskId);
  res.status(httpStatus.StatusCodes.OK).json({ success: true, data });
}

async function trackRecent(req, res) {
  const data = await homeService.trackRecent(req.user.id, req.body);
  res.status(httpStatus.StatusCodes.OK).json({ success: true, data });
}

module.exports = {
  overview,
  updatePreferences,
  myTasks,
  addPersonal,
  removePersonal,
  trackRecent,
};
