const activityLogRepository = require('../repositories/activityLog.repository');

class ActivityService {
  async record({ actor, action, entityType, entityId, metadata = {} }) {
    return activityLogRepository.create({ actor, action, entityType, entityId, metadata });
  }

  async getTimeline(entityType, entityId) {
    return activityLogRepository.findByEntity(entityType, entityId);
  }
}

module.exports = new ActivityService();
