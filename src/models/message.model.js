const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema(
  {
    from: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    to: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', default: null },
    team: { type: mongoose.Schema.Types.ObjectId, ref: 'Team', default: null },
    /** Real-time chat thread (ClickUp-style inbox chat) */
    conversation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Conversation',
      default: null,
      index: true,
    },
    subject: { type: String, trim: true, maxlength: 200, default: null },
    body: { type: String, required: true, trim: true, maxlength: 5000 },
    parentMessage: { type: mongoose.Schema.Types.ObjectId, ref: 'Message', default: null },
    type: {
      type: String,
      enum: ['query', 'reply', 'announcement', 'chat'],
      default: 'query',
    },
    mentions: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    /** Shared deep links (task/project/conversation/external) */
    shareLinks: [
      {
        url: { type: String, required: true, trim: true, maxlength: 1000 },
        label: { type: String, trim: true, maxlength: 200, default: '' },
        kind: {
          type: String,
          enum: ['task', 'project', 'conversation', 'external'],
          default: 'external',
        },
        refId: { type: mongoose.Schema.Types.ObjectId, default: null },
      },
    ],
    isRead: { type: Boolean, default: false },
  },
  { timestamps: true }
);

messageSchema.index({ to: 1, isRead: 1, createdAt: -1 });
messageSchema.index({ from: 1, createdAt: -1 });
messageSchema.index({ department: 1, createdAt: -1 });
messageSchema.index({ conversation: 1, createdAt: 1 });

module.exports = mongoose.model('Message', messageSchema);
