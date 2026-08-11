const BaseRepository = require('./base.repository');
const Task = require('../models/task.model');

class TaskRepository extends BaseRepository {
  constructor() {
    super(Task);
  }

  async findByProjectGroupedByStatus(projectId) {
    return this.model
      .find({ project: projectId, parentTask: null, isArchived: false })
      .sort('position')
      .populate('assignees', 'name avatarUrl email')
      .populate('reporter', 'name avatarUrl')
      .exec();
  }

  async findSubtasks(parentTaskId) {
    return this.model
      .find({ parentTask: parentTaskId })
      .sort('position')
      .populate('assignees', 'name avatarUrl')
      .exec();
  }

  async getMaxPositionInColumn(projectId, status) {
    const last = await this.model
      .findOne({ project: projectId, status })
      .sort('-position')
      .select('position')
      .exec();
    return last ? last.position : 0;
  }

  async search(projectId, text) {
    return this.model
      .find({ project: projectId, $text: { $search: text } })
      .limit(20)
      .exec();
  }
}

module.exports = new TaskRepository();
