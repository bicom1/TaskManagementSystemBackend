const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    method: { type: String, required: true },
    route: { type: String, required: true },
    statusCode: { type: Number, required: true },
    ip: { type: String },
    userAgent: { type: String },
    durationMs: { type: Number },
  },
  { timestamps: true }
);

auditLogSchema.index({ user: 1, createdAt: -1 });
// TTL: auto-purge audit logs after 180 days to bound collection growth
auditLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 180 });

module.exports = mongoose.model('AuditLog', auditLogSchema);
