const mongoose = require('mongoose');

const conversationSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ['dm', 'team', 'department', 'task'],
      default: 'dm',
      required: true,
    },
    /** Sorted "userIdA:userIdB" for unique 1:1 DMs */
    dmKey: {
      type: String,
      default: null,
      sparse: true,
      unique: true,
    },
    participants: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
      },
    ],
    team: { type: mongoose.Schema.Types.ObjectId, ref: 'Team', default: null },
    department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', default: null },
    relatedTask: { type: mongoose.Schema.Types.ObjectId, ref: 'Task', default: null },
    relatedProject: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', default: null },
    title: { type: String, trim: true, maxlength: 120, default: null },
    lastMessageAt: { type: Date, default: Date.now },
    lastMessagePreview: { type: String, trim: true, maxlength: 240, default: '' },
    lastMessageBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    /** Per-user last read timestamp */
    readState: [
      {
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        lastReadAt: { type: Date, default: Date.now },
      },
    ],
    isActive: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

conversationSchema.index({ participants: 1, lastMessageAt: -1 });
conversationSchema.index({ type: 1, team: 1 });
conversationSchema.index({ type: 1, department: 1 });
conversationSchema.index({ relatedTask: 1 });

module.exports = mongoose.model('Conversation', conversationSchema);
