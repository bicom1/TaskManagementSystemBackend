const httpStatus = require('http-status-codes');
const meetingService = require('../services/meeting.service');
const meetingsAiService = require('../services/meetingsAi.service');

async function listMeetings(req, res) {
  const data = await meetingService.listForUser(req.user.id);
  res.status(httpStatus.StatusCodes.OK).json({ success: true, data });
}

async function createMeeting(req, res) {
  const data = await meetingService.create(req.body, req.user.id);
  res.status(httpStatus.StatusCodes.CREATED).json({ success: true, data });
}

async function listLocations(req, res) {
  const data = await meetingService.listLocations(req.user.id);
  res.status(httpStatus.StatusCodes.OK).json({ success: true, data });
}

async function createLocation(req, res) {
  const data = await meetingService.createLocation(req.body, req.user.id);
  res.status(httpStatus.StatusCodes.CREATED).json({ success: true, data });
}

async function workspace(req, res) {
  const data = await meetingService.workspaceSummary(req.user.id);
  res.status(httpStatus.StatusCodes.OK).json({ success: true, data });
}

async function ask(req, res) {
  const data = await meetingsAiService.ask(req.user.id, req.body?.prompt || '');
  res.status(httpStatus.StatusCodes.OK).json({ success: true, data });
}

async function calendarBoard(req, res) {
  const data = await meetingsAiService.calendarBoard(req.user.id);
  res.status(httpStatus.StatusCodes.OK).json({ success: true, data });
}

module.exports = {
  listMeetings,
  createMeeting,
  listLocations,
  createLocation,
  workspace,
  ask,
  calendarBoard,
};
