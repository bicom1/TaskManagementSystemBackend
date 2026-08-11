const BaseRepository = require('./base.repository');
const ActivityLog = require('../models/activityLog.model');

class ActivityLogRepository extends BaseRepository {
  constructor() {
    super(ActivityLog);
  }

  async findByEntity(entityType, entityId) {
    return this.model
      .find({ entityType, entityId })
      .sort('-createdAt')
      .populate('actor', 'name avatarUrl')
      .exec();
  }
}

module.exports = new ActivityLogRepository();
