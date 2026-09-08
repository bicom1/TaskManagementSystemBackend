const mongoose = require('mongoose');
const {
  NOTIFICATION_TYPE_VALUES,
  NOTIFICATION_SCOPES,
  ENTITY_TYPES,
} = require('../constants/notification.constant');

const notificationSchema = new mongoose.Schema(
  {
    recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    type: { type: String, enum: NOTIFICATION_TYPE_VALUES, required: true },
    message: { type: String, required: true, trim: true },
    /**
     * personal → only the associated recipient (chat, assignment, mention, …)
     * system → Superadmin-only (deletes, invites, org admin events)
     */
    scope: {
      type: String,
      enum: Object.values(NOTIFICATION_SCOPES),
      default: NOTIFICATION_SCOPES.PERSONAL,
      index: true,
    },
    entityType: { type: String, enum: ENTITY_TYPES, required: true },
    entityId: { type: mongoose.Schema.Types.ObjectId, required: true },
    isRead: { type: Boolean, default: false },
  },
  { timestamps: true }
);

notificationSchema.index({ recipient: 1, isRead: 1, createdAt: -1 });
notificationSchema.index({ recipient: 1, scope: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);
