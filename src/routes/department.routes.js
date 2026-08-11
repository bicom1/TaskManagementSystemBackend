const { Router } = require('express');
const controller = require('../controllers/department.controller');
const authenticate = require('../middlewares/auth.middleware');
const { loadActorContext, requirePermission } = require('../middlewares/permission.middleware');
const validate = require('../middlewares/validate.middleware');
const { PERMISSIONS } = require('../constants/permissions.constant');
const { createDepartmentSchema, updateDepartmentSchema } = require('../validators/department.validator');

const router = Router();
router.use(authenticate);
router.use(loadActorContext);

router.get('/', requirePermission(PERMISSIONS.DEPARTMENT_VIEW), controller.list);
router.get('/:id', requirePermission(PERMISSIONS.DEPARTMENT_VIEW), controller.getById);
router.post(
  '/',
  requirePermission(PERMISSIONS.DEPARTMENT_MANAGE),
  validate(createDepartmentSchema),
  controller.create
);
router.patch(
  '/:id',
  requirePermission(PERMISSIONS.DEPARTMENT_MANAGE),
  validate(updateDepartmentSchema),
  controller.update
);
router.delete(
  '/:id',
  requirePermission(PERMISSIONS.DEPARTMENT_MANAGE),
  controller.deactivate
);

module.exports = router;
