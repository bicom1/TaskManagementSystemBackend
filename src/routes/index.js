const { Router } = require('express');

const authRoutes = require('./auth.routes');
const userRoutes = require('./user.routes');
const departmentRoutes = require('./department.routes');
const teamRoutes = require('./team.routes');
const projectRoutes = require('./project.routes');
const taskRoutes = require('./task.routes');
const commentRoutes = require('./comment.routes');
const notificationRoutes = require('./notification.routes');
const messageRoutes = require('./message.routes');
const reportRoutes = require('./report.routes');
const homeRoutes = require('./home.routes');
const meetingRoutes = require('./meeting.routes');
const auditRoutes = require('./audit.routes');
const chatRoutes = require('./chat.routes');

const router = Router();

router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/departments', departmentRoutes);
router.use('/teams', teamRoutes);
router.use('/projects', projectRoutes);
router.use('/tasks', taskRoutes);
router.use('/comments', commentRoutes);
router.use('/notifications', notificationRoutes);
router.use('/messages', messageRoutes);
router.use('/chat', chatRoutes);
router.use('/reports', reportRoutes);
router.use('/home', homeRoutes);
router.use('/workspace', meetingRoutes);
router.use('/audit', auditRoutes);

module.exports = router;
