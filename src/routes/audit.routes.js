const { Router } = require('express');
const controller = require('../controllers/audit.controller');
const authenticate = require('../middlewares/auth.middleware');
const { loadActorContext, requirePermission } = require('../middlewares/permission.middleware');
const { PERMISSIONS } = require('../constants/permissions.constant');

const router = Router();
router.use(authenticate);
router.use(loadActorContext);

router.get('/logs', requirePermission(PERMISSIONS.AUDIT_VIEW), controller.listAuditLogs);
router.get('/activity', requirePermission(PERMISSIONS.AUDIT_VIEW), controller.listActivity);

module.exports = router;
