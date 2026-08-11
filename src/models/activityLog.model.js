const mongoose = require('mongoose');

const activityLogSchema = new mongoose.Schema(
  {
    actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    action: { type: String, required: true }, // e.g. "status_changed", "assignee_added"
    entityType: { type: String, enum: ['Task', 'Project', 'Comment'], required: true },
    entityId: { type: mongoose.Schema.Types.ObjectId, required: true },
    // Free-form before/after snapshot for rendering a human-readable diff
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

activityLogSchema.index({ entityType: 1, entityId: 1, createdAt: -1 });

module.exports = mongoose.model('ActivityLog', activityLogSchema);
