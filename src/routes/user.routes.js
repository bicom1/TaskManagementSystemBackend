const { Router } = require('express');
const auth = require('../middlewares/auth.middleware');
const { requirePermission, loadActorContext } = require('../middlewares/permission.middleware');
const validate = require('../middlewares/validate.middleware');
const userController = require('../controllers/user.controller');
const {
  inviteUserSchema,
  updateMeSchema,
  changePasswordSchema,
  updateUserSchema,
  acceptInviteSchema,
} = require('../validators/user.validator');
const { PERMISSIONS } = require('../constants/permissions.constant');

const router = Router();

// Public invite acceptance (token-based)
router.get('/invite/preview', userController.previewInvite);
router.post('/invite/accept', validate(acceptInviteSchema), userController.acceptInvite);

router.use(auth);
router.use(loadActorContext);

router.get('/me', userController.me);
router.patch('/me', validate(updateMeSchema), userController.updateMe);
router.patch('/me/password', validate(changePasswordSchema), userController.changePassword);

router.get('/', requirePermission(PERMISSIONS.USER_VIEW), userController.list);

router.post(
  '/invite',
  requirePermission(PERMISSIONS.USER_INVITE),
  validate(inviteUserSchema),
  userController.invite
);

router.get('/:id', requirePermission(PERMISSIONS.USER_VIEW), userController.getById);

router.patch(
  '/:id',
  requirePermission(PERMISSIONS.USER_MANAGE),
  validate(updateUserSchema),
  userController.updateUser
);
router.patch(
  '/:id/deactivate',
  requirePermission(PERMISSIONS.USER_MANAGE),
  userController.deactivate
);
router.patch(
  '/:id/reactivate',
  requirePermission(PERMISSIONS.USER_MANAGE),
  userController.reactivate
);
router.delete(
  '/:id',
  requirePermission(PERMISSIONS.USER_MANAGE),
  userController.remove
);

module.exports = router;
