const mongoose = require('mongoose');
const {
  TASK_STATUS_VALUES,
  TASK_PRIORITY_VALUES,
  TASK_STATUS,
  TASK_PRIORITY,
} = require('../constants/task.constant');

const APPROVAL_STATUS = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
});

const attachmentSchema = new mongoose.Schema(
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

const checklistItemSchema = new mongoose.Schema(
  {
    text: { type: String, required: true, trim: true, maxlength: 500 },
    isDone: { type: Boolean, default: false },
    doneAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

const recurrenceSchema = new mongoose.Schema(
  {
    enabled: { type: Boolean, default: false },
    frequency: {
      type: String,
      enum: ['daily', 'weekly', 'monthly'],
      default: 'weekly',
    },
    nextRunAt: { type: Date, default: null },
  },
  { _id: false }
);

const taskSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, trim: true, maxlength: 5000 },
    project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true },
    parentTask: { type: mongoose.Schema.Types.ObjectId, ref: 'Task', default: null },
    status: { type: String, enum: TASK_STATUS_VALUES, default: TASK_STATUS.BACKLOG },
    priority: { type: String, enum: TASK_PRIORITY_VALUES, default: TASK_PRIORITY.MEDIUM },
    assignees: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    reporter: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    dueDate: { type: Date },
    labels: [{ type: String, trim: true }],
    attachments: [attachmentSchema],
    checklist: [checklistItemSchema],
    blockedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Task' }],
    relatedTasks: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Task' }],
    estimateHours: { type: Number, min: 0, default: null },
    loggedHours: { type: Number, min: 0, default: null },
    recurrence: {
      type: recurrenceSchema,
      default: () => ({ enabled: false, frequency: 'weekly', nextRunAt: null }),
    },
    position: { type: Number, required: true, default: 0 },
    isArchived: { type: Boolean, default: false },
    approvalStatus: {
      type: String,
      enum: Object.values(APPROVAL_STATUS),
      default: APPROVAL_STATUS.APPROVED,
    },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    approvedAt: { type: Date, default: null },
    rejectionReason: { type: String, trim: true, maxlength: 500, default: null },
  },
  { timestamps: true }
);

taskSchema.index({ project: 1, status: 1, position: 1 });
taskSchema.index({ parentTask: 1 });
taskSchema.index({ assignees: 1, isArchived: 1, status: 1, dueDate: 1 });
taskSchema.index({ assignees: 1, status: 1, updatedAt: -1 });
taskSchema.index({ project: 1, isArchived: 1, status: 1 });
taskSchema.index({ approvalStatus: 1 });
taskSchema.index({ title: 'text', description: 'text' });

const Task = mongoose.model('Task', taskSchema);
Task.APPROVAL_STATUS = APPROVAL_STATUS;
module.exports = Task;
