const mongoose = require('mongoose');
const { NOTIFICATION_TYPE_VALUES } = require('../constants/notification.constant');

const notificationSchema = new mongoose.Schema(
  {
    recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    type: { type: String, enum: NOTIFICATION_TYPE_VALUES, required: true },
    message: { type: String, required: true, trim: true },
    // Polymorphic link back to the source entity (task, project, comment...)
    entityType: { type: String, enum: ['Task', 'Project', 'Comment'], required: true },
    entityId: { type: mongoose.Schema.Types.ObjectId, required: true },
    isRead: { type: Boolean, default: false },
  },
  { timestamps: true }
);

notificationSchema.index({ recipient: 1, isRead: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);
