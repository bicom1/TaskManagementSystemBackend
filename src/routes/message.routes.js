const { Router } = require('express');
const authenticate = require('../middlewares/auth.middleware');
const validate = require('../middlewares/validate.middleware');
const controller = require('../controllers/message.controller');
const { validateObjectIdParam } = require('../middlewares/validateObjectId.middleware');
const {
  sendMessageSchema,
  createTaskFromMessageSchema,
} = require('../validators/message.validator');

const router = Router();
router.use(authenticate);

router.get('/inbox', controller.inbox);
router.patch('/mark-all-read', controller.markAllRead);
router.post('/', validate(sendMessageSchema), controller.send);
router.post(
  '/:id/create-task',
  validateObjectIdParam('id'),
  validate(createTaskFromMessageSchema),
  controller.createTask
);
router.patch('/:id/read', validateObjectIdParam('id'), controller.markRead);

module.exports = router;
