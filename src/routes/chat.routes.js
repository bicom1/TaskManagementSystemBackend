const { Router } = require('express');
const authenticate = require('../middlewares/auth.middleware');
const validate = require('../middlewares/validate.middleware');
const controller = require('../controllers/chat.controller');
const {
  startDmSchema,
  startTeamSchema,
  startDepartmentSchema,
  startTaskSchema,
  sendChatMessageSchema,
} = require('../validators/chat.validator');

const router = Router();
// Chat is open to every authenticated user — no role/permission gates
router.use(authenticate);

router.get('/directory', controller.directory);
router.get('/people', controller.searchPeople);
router.get('/conversations', controller.listConversations);
router.get('/conversations/:id', controller.getConversation);
router.get('/conversations/:id/messages', controller.listMessages);

router.post('/dm', validate(startDmSchema), controller.startDm);
router.post('/team', validate(startTeamSchema), controller.startTeamChat);
router.post('/department', validate(startDepartmentSchema), controller.startDepartmentChat);
router.post('/task', validate(startTaskSchema), controller.startTaskChat);

router.post(
  '/conversations/:id/messages',
  validate(sendChatMessageSchema),
  controller.sendMessage
);
router.patch('/conversations/:id/read', controller.markRead);

module.exports = router;
