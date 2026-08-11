const httpStatus = require('http-status-codes');
const reportService = require('../services/report.service');

function actorFrom(req) {
  return req.user.context || req.user;
}

async function workspaceOverview(req, res) {
  const data = await reportService.workspaceOverview(actorFrom(req));
  res.status(httpStatus.StatusCodes.OK).json({ success: true, data });
}

async function projectSummary(req, res) {
  const summary = await reportService.projectSummary(req.params.projectId, actorFrom(req));
  res.status(httpStatus.StatusCodes.OK).json({ success: true, data: summary });
}

async function teamWorkload(req, res) {
  const workload = await reportService.teamWorkload(req.params.projectId, actorFrom(req));
  res.status(httpStatus.StatusCodes.OK).json({ success: true, data: workload });
}

async function completionTrend(req, res) {
  const days = req.query.days ? Number(req.query.days) : 14;
  const trend = await reportService.completionTrend(
    req.params.projectId,
    days,
    actorFrom(req)
  );
  res.status(httpStatus.StatusCodes.OK).json({ success: true, data: trend });
}

module.exports = { workspaceOverview, projectSummary, teamWorkload, completionTrend };
