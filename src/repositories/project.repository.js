const BaseRepository = require('./base.repository');
const Project = require('../models/project.model');

class ProjectRepository extends BaseRepository {
  constructor() {
    super(Project);
  }

  async existsByKey(key) {
    return this.model.exists({ key });
  }

  /**
   * Atomically increments and returns the next task sequence number for
   * human-readable keys (ENG-1, ENG-2...) — avoids race conditions from
   * read-then-write under concurrent task creation.
   */
  async getNextTaskSequence(projectId) {
    const project = await this.model
      .findByIdAndUpdate(projectId, { $inc: { taskSequence: 1 } }, { new: true })
      .exec();
    return project.taskSequence;
  }
}

module.exports = new ProjectRepository();
