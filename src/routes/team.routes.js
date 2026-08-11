const { Router } = require('express');
const controller = require('../controllers/team.controller');
const authenticate = require('../middlewares/auth.middleware');
const { loadActorContext, requirePermission } = require('../middlewares/permission.middleware');
const validate = require('../middlewares/validate.middleware');
const { PERMISSIONS } = require('../constants/permissions.constant');
const { createTeamSchema, updateTeamSchema } = require('../validators/team.validator');

const router = Router();
router.use(authenticate);
router.use(loadActorContext);

router.get('/', requirePermission(PERMISSIONS.TEAM_VIEW), controller.list);
router.get('/:id', requirePermission(PERMISSIONS.TEAM_VIEW), controller.getById);
router.post(
  '/',
  requirePermission(PERMISSIONS.TEAM_MANAGE),
  validate(createTeamSchema),
  controller.create
);
router.patch(
  '/:id',
  requirePermission(PERMISSIONS.TEAM_MANAGE),
  validate(updateTeamSchema),
  controller.update
);
router.post(
  '/:id/members',
  requirePermission(PERMISSIONS.TEAM_MANAGE),
  controller.addMember
);
router.delete(
  '/:id/members/:userId',
  requirePermission(PERMISSIONS.TEAM_MANAGE),
  controller.removeMember
);

module.exports = router;
