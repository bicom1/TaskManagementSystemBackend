const { Router } = require('express');
const authenticate = require('../middlewares/auth.middleware');
const validate = require('../middlewares/validate.middleware');
const upload = require('../middlewares/upload.middleware');
const controller = require('../controllers/chat.controller');
const {
  startDmSchema,
  startTeamSchema,
  startDepartmentSchema,
  startTaskSchema,
  startProjectSchema,
  sendChatMessageSchema,
} = require('../validators/chat.validator');
const { MAX_FILES_PER_MESSAGE } = require('../constants/chat.constant');

const router = Router();
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
router.post('/project', validate(startProjectSchema), controller.startProjectChat);

router.post(
  '/conversations/:id/messages',
  upload.array('files', MAX_FILES_PER_MESSAGE),
  controller.normalizeChatMessageBody,
  validate(sendChatMessageSchema),
  controller.sendMessage
);
router.patch('/conversations/:id/read', controller.markRead);

module.exports = router;
