const { Router } = require('express');
const controller = require('../controllers/task.controller');
const authenticate = require('../middlewares/auth.middleware');
const { loadActorContext } = require('../middlewares/permission.middleware');
const validate = require('../middlewares/validate.middleware');
const upload = require('../middlewares/upload.middleware');
const { validateObjectIdParam } = require('../middlewares/validateObjectId.middleware');
const { createTaskSchema, updateTaskSchema, moveTaskSchema } = require('../validators/task.validator');

const router = Router();
router.use(authenticate);
router.use(loadActorContext);

router.get('/approvals/pending', controller.getPendingApprovals);
router.get('/board/:projectId', validateObjectIdParam('projectId'), controller.getBoard);

router.post('/', validate(createTaskSchema), controller.create);
router.post(
  '/:id/attachments',
  validateObjectIdParam('id'),
  upload.single('file'),
  controller.uploadAttachment
);

router.patch('/:id/approve', validateObjectIdParam('id'), controller.approve);
router.patch('/:id/reject', validateObjectIdParam('id'), controller.reject);
router.patch('/:id/advance', validateObjectIdParam('id'), controller.advance);
router.patch(
  '/:id/move',
  validateObjectIdParam('id'),
  validate(moveTaskSchema),
  controller.move
);
router.patch('/:id', validateObjectIdParam('id'), validate(updateTaskSchema), controller.update);

router.get('/:id/subtasks', validateObjectIdParam('id'), controller.getSubtasks);
router.get('/:id/activity', validateObjectIdParam('id'), controller.getActivity);
router.get('/:id', validateObjectIdParam('id'), controller.getById);
router.delete('/:id', validateObjectIdParam('id'), controller.remove);

module.exports = router;
