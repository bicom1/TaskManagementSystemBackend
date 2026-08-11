const commentRepository = require('../repositories/comment.repository');
const taskRepository = require('../repositories/task.repository');
const activityService = require('./activity.service');
const notificationService = require('./notification.service');
const ApiError = require('../utils/ApiError.util');
const { NOTIFICATION_TYPES } = require('../constants/notification.constant');

class CommentService {
  async create({ taskId, content, mentions = [] }, actorId) {
    const task = await taskRepository.findById(taskId);
    if (!task) throw ApiError.notFound('Task not found');

    const comment = await commentRepository.create({
      task: taskId,
      author: actorId,
      content,
      mentions,
    });

    await activityService.record({
      actor: actorId,
      action: 'comment_added',
      entityType: 'Task',
      entityId: taskId,
    });

    // Notify assignees of the new comment (excluding the author)
    const toNotify = new Set([
      ...task.assignees.map((a) => a.toString()),
      ...mentions.map((m) => m.toString()),
    ]);
    toNotify.delete(actorId);

    await Promise.all(
      [...toNotify].map((recipientId) =>
        notificationService.notify({
          recipient: recipientId,
          sender: actorId,
          type: mentions.map(String).includes(recipientId)
            ? NOTIFICATION_TYPES.MENTIONED
            : NOTIFICATION_TYPES.COMMENT_ADDED,
          message: `New comment on "${task.title}"`,
          entityType: 'Task',
          entityId: taskId,
        })
      )
    );

    // Employee comments advance todo → in_progress automatically
    try {
      const taskService = require('./task.service');
      await taskService.applyCommentProgress(taskId, actorId);
    } catch {
      /* non-blocking */
    }

    return comment;
  }

  async listByTask(taskId) {
    return commentRepository.findByTask(taskId);
  }

  async update(id, content, actorId) {
    const comment = await commentRepository.findById(id);
    if (!comment) throw ApiError.notFound('Comment not found');
    if (comment.author.toString() !== actorId) {
      throw ApiError.forbidden('You can only edit your own comments');
    }
    return commentRepository.updateById(id, { content, editedAt: new Date() });
  }

  async delete(id, actorId, actorRole) {
    const comment = await commentRepository.findById(id);
    if (!comment) throw ApiError.notFound('Comment not found');
    if (comment.author.toString() !== actorId && actorRole !== 'admin') {
      throw ApiError.forbidden('You can only delete your own comments');
    }
    return commentRepository.deleteById(id);
  }
}

module.exports = new CommentService();
