const { Router } = require('express');
const controller = require('../controllers/report.controller');
const authenticate = require('../middlewares/auth.middleware');
const { loadActorContext, requirePermission } = require('../middlewares/permission.middleware');
const { PERMISSIONS } = require('../constants/permissions.constant');
const { validateObjectIdParam } = require('../middlewares/validateObjectId.middleware');

const router = Router();
router.use(authenticate);
router.use(loadActorContext);

router.get(
  '/workspace',
  requirePermission(PERMISSIONS.REPORT_VIEW),
  controller.workspaceOverview
);
router.get(
  '/project/:projectId/summary',
  validateObjectIdParam('projectId'),
  requirePermission(PERMISSIONS.REPORT_VIEW),
  controller.projectSummary
);
router.get(
  '/project/:projectId/workload',
  validateObjectIdParam('projectId'),
  requirePermission(PERMISSIONS.REPORT_VIEW),
  controller.teamWorkload
);
router.get(
  '/project/:projectId/trend',
  validateObjectIdParam('projectId'),
  requirePermission(PERMISSIONS.REPORT_VIEW),
  controller.completionTrend
);
router.get(
  '/analytics',
  requirePermission(PERMISSIONS.REPORT_VIEW),
  controller.workloadAnalytics
);

module.exports = router;
