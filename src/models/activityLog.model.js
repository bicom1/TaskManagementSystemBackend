const mongoose = require('mongoose');
const { ENTITY_TYPES } = require('../constants/notification.constant');

const activityLogSchema = new mongoose.Schema(
  {
    actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    action: { type: String, required: true }, // e.g. "status_changed", "assignee_added"
    // Shares the notification list. It used to allow only Task/Project/Comment, so
    // user events had to be recorded as 'Project' and the audit log showed them so.
    entityType: { type: String, enum: ENTITY_TYPES, required: true },
    entityId: { type: mongoose.Schema.Types.ObjectId, required: true },
    // Free-form before/after snapshot for rendering a human-readable diff
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

activityLogSchema.index({ entityType: 1, entityId: 1, createdAt: -1 });

module.exports = mongoose.model('ActivityLog', activityLogSchema);
