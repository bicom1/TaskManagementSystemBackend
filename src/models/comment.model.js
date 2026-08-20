const mongoose = require('mongoose');

const commentAttachmentSchema = new mongoose.Schema(
  {
    url: { type: String, required: true },
    publicId: { type: String, required: true },
    fileName: { type: String, required: true },
    fileType: { type: String },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const commentLinkSchema = new mongoose.Schema(
  {
    url: { type: String, required: true, trim: true, maxlength: 2000 },
    title: { type: String, trim: true, maxlength: 200, default: '' },
  },
  { _id: false }
);

const commentSchema = new mongoose.Schema(
  {
    task: { type: mongoose.Schema.Types.ObjectId, ref: 'Task', required: true },
    author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    content: { type: String, default: '', trim: true, maxlength: 3000 },
    mentions: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    attachments: { type: [commentAttachmentSchema], default: [] },
    links: { type: [commentLinkSchema], default: [] },
    editedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

commentSchema.index({ task: 1, createdAt: -1 });

module.exports = mongoose.model('Comment', commentSchema);
