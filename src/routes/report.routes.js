const { Router } = require('express');
const controller = require('../controllers/report.controller');
const authenticate = require('../middlewares/auth.middleware');
const { loadActorContext, requirePermission } = require('../middlewares/permission.middleware');
const { PERMISSIONS } = require('../constants/permissions.constant');

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
  requirePermission(PERMISSIONS.REPORT_VIEW),
  controller.projectSummary
);
router.get(
  '/project/:projectId/workload',
  requirePermission(PERMISSIONS.REPORT_VIEW),
  controller.teamWorkload
);
router.get(
  '/project/:projectId/trend',
  requirePermission(PERMISSIONS.REPORT_VIEW),
  controller.completionTrend
);

module.exports = router;
