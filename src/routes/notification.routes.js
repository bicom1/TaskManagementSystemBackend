const { Router } = require('express');
const controller = require('../controllers/notification.controller');
const authenticate = require('../middlewares/auth.middleware');

const router = Router();
router.use(authenticate);

router.get('/', controller.list);
router.get('/unread-count', controller.unreadCount);
router.patch('/mark-all-read', controller.markAllRead);

module.exports = router;
