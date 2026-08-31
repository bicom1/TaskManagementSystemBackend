const { Router } = require('express');
const { z } = require('zod');
const authenticate = require('../middlewares/auth.middleware');
const validate = require('../middlewares/validate.middleware');
const meetingController = require('../controllers/meeting.controller');

const router = Router();
router.use(authenticate);

const meetingSchema = z.object({
  body: z.object({
    title: z.string().trim().min(2).max(200),
    description: z.string().trim().max(2000).optional(),
    startsAt: z.string().or(z.coerce.date()),
    endsAt: z.string().or(z.coerce.date()),
    team: z.string().length(24).optional().nullable(),
    department: z.string().length(24).optional().nullable(),
    project: z.string().length(24).optional().nullable(),
    location: z.string().length(24).optional().nullable(),
    locationLabel: z.string().max(200).optional(),
    attendees: z.array(z.string().length(24)).optional(),
    meetingUrl: z.string().max(500).optional(),
  }),
});

const locationSchema = z.object({
  body: z.object({
    name: z.string().trim().min(2).max(120),
    address: z.string().max(300).optional(),
    city: z.string().max(100).optional(),
    type: z.enum(['office', 'remote', 'client', 'other']).optional(),
    team: z.string().length(24).optional().nullable(),
    department: z.string().length(24).optional().nullable(),
  }),
});

const askSchema = z.object({
  body: z.object({
    prompt: z.string().trim().min(1).max(1000),
  }),
});

router.get('/workspace', meetingController.workspace);
router.get('/meetings', meetingController.listMeetings);
router.get('/meetings/calendar', meetingController.calendarBoard);
router.post('/meetings/ask', validate(askSchema), meetingController.ask);
router.post(
  '/meetings',
  validate(meetingSchema),
  meetingController.createMeeting
);
router.get('/locations', meetingController.listLocations);
router.post(
  '/locations',
  validate(locationSchema),
  meetingController.createLocation
);

module.exports = router;
