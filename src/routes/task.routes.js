const { Router } = require('express');
const controller = require('../controllers/task.controller');
const authenticate = require('../middlewares/auth.middleware');
const { loadActorContext } = require('../middlewares/permission.middleware');
const validate = require('../middlewares/validate.middleware');
const upload = require('../middlewares/upload.middleware');
const { createTaskSchema, updateTaskSchema, moveTaskSchema } = require('../validators/task.validator');

const router = Router();
router.use(authenticate);
router.use(loadActorContext);

router.get('/approvals/pending', controller.getPendingApprovals);
router.get('/board/:projectId', controller.getBoard);

router.post('/', validate(createTaskSchema), controller.create);
router.post('/:id/attachments', upload.single('file'), controller.uploadAttachment);

// Specific :id actions before generic :id routes
router.patch('/:id/approve', controller.approve);
router.patch('/:id/reject', controller.reject);
router.patch('/:id/advance', controller.advance);
router.patch('/:id/move', validate(moveTaskSchema), controller.move);
router.patch('/:id', validate(updateTaskSchema), controller.update);

router.get('/:id/subtasks', controller.getSubtasks);
router.get('/:id/activity', controller.getActivity);
router.get('/:id', controller.getById);
router.delete('/:id', controller.remove);

module.exports = router;
