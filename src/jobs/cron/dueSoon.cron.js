const cron = require('node-cron');
const Task = require('../../models/task.model');
const notificationService = require('../../services/notification.service');
const logger = require('../../config/logger');
const { NOTIFICATION_TYPES } = require('../../constants/notification.constant');
const { TASK_STATUS } = require('../../constants/task.constant');

function startDueSoonCron() {
  // Runs every hour, on the hour
  cron.schedule('0 * * * *', async () => {
    try {
      const in24h = new Date(Date.now() + 24 * 60 * 60 * 1000);

      const dueSoonTasks = await Task.find({
        dueDate: { $lte: in24h, $gte: new Date() },
        status: { $ne: TASK_STATUS.DONE },
        isArchived: false,
      }).select('_id title assignees dueDate');

      for (const task of dueSoonTasks) {
        for (const assigneeId of task.assignees) {
          // eslint-disable-next-line no-await-in-loop
          await notificationService.notify({
            recipient: assigneeId,
            type: NOTIFICATION_TYPES.TASK_DUE_SOON,
            message: `"${task.title}" is due soon`,
            entityType: 'Task',
            entityId: task._id,
          });
        }
      }

      logger.debug(`Due-soon cron: notified for ${dueSoonTasks.length} tasks`);
    } catch (err) {
      logger.error('Due-soon cron failed', err);
    }
  });
}

module.exports = startDueSoonCron;
