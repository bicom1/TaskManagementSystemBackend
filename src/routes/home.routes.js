const { Router } = require('express');
const { z } = require('zod');
const authenticate = require('../middlewares/auth.middleware');
const validate = require('../middlewares/validate.middleware');
const homeController = require('../controllers/home.controller');

const router = Router();
router.use(authenticate);

const prefsSchema = z.object({
  body: z.object({
    homeCards: z
      .array(
        z.object({
          id: z.string(),
          enabled: z.boolean().optional(),
          order: z.number().optional(),
        })
      )
      .optional(),
    calendarProvider: z.enum(['none', 'google', 'outlook']).optional(),
  }),
});

const personalSchema = z.object({
  body: z.object({
    taskId: z.string().min(1),
  }),
});

const recentSchema = z.object({
  body: z.object({
    type: z.enum(['task', 'project']),
    refId: z.string().min(1),
    title: z.string().min(1),
    subtitle: z.string().optional(),
    projectId: z.string().optional().nullable(),
  }),
});

router.get('/', homeController.overview);
router.get('/my-tasks', homeController.myTasks);
router.patch('/preferences', validate(prefsSchema), homeController.updatePreferences);
router.post('/personal-list', validate(personalSchema), homeController.addPersonal);
router.delete('/personal-list/:taskId', homeController.removePersonal);
router.post('/recents', validate(recentSchema), homeController.trackRecent);

module.exports = router;
