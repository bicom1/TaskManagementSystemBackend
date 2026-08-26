const BaseRepository = require('./base.repository');
const Notification = require('../models/notification.model');

class NotificationRepository extends BaseRepository {
  constructor() {
    super(Notification);
  }

  async markAllRead(userId) {
    return this.model.updateMany({ recipient: userId, isRead: false }, { isRead: true }).exec();
  }

  async markOneRead(id, userId) {
    return this.model
      .findOneAndUpdate(
        { _id: id, recipient: userId, isRead: false },
        { isRead: true },
        { new: true }
      )
      .exec();
  }

  async unreadCount(userId) {
    return this.model.countDocuments({ recipient: userId, isRead: false });
  }
}

module.exports = new NotificationRepository();
