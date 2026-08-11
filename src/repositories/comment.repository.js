const BaseRepository = require('./base.repository');
const Comment = require('../models/comment.model');

class CommentRepository extends BaseRepository {
  constructor() {
    super(Comment);
  }

  async findByTask(taskId) {
    return this.model
      .find({ task: taskId })
      .sort('createdAt')
      .populate('author', 'name avatarUrl')
      .exec();
  }
}

module.exports = new CommentRepository();
