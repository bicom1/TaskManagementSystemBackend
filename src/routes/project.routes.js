const { Router } = require('express');
const controller = require('../controllers/project.controller');
const authenticate = require('../middlewares/auth.middleware');
const { loadActorContext, requirePermission } = require('../middlewares/permission.middleware');
const validate = require('../middlewares/validate.middleware');
const { PERMISSIONS } = require('../constants/permissions.constant');
const { createProjectSchema, updateProjectSchema } = require('../validators/project.validator');

const router = Router();
router.use(authenticate);
router.use(loadActorContext);

router.get('/', requirePermission(PERMISSIONS.PROJECT_VIEW), controller.list);
router.get('/:id', requirePermission(PERMISSIONS.PROJECT_VIEW), controller.getById);
router.post(
  '/',
  requirePermission(PERMISSIONS.PROJECT_CREATE),
  validate(createProjectSchema),
  controller.create
);
router.patch(
  '/:id',
  requirePermission(PERMISSIONS.PROJECT_EDIT),
  validate(updateProjectSchema),
  controller.update
);
router.post(
  '/:id/members',
  requirePermission(PERMISSIONS.PROJECT_EDIT),
  controller.addMember
);
router.delete(
  '/:id',
  requirePermission(PERMISSIONS.PROJECT_EDIT),
  controller.remove
);

module.exports = router;
