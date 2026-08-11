const mongoose = require('mongoose');
const {
  SPACE_PERMISSION_VALUES,
  SPACE_VIEW_VALUES,
  WORKFLOW_TEMPLATE_IDS,
  getWorkflowTemplate,
} = require('../constants/space.constant');

const statusSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true },
    label: { type: String, required: true, trim: true, maxlength: 40 },
    color: { type: String, trim: true, default: '#9ca3af' },
  },
  { _id: false }
);

const defaultWorkflow = getWorkflowTemplate('starter');

/**
 * Spaces in the UI map to Project documents.
 * ClickUp-style metadata (icon, privacy, workflow template, views) lives here.
 */
const projectSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 150 },
    key: { type: String, required: true, trim: true, uppercase: true, maxlength: 10 },
    description: { type: String, trim: true, maxlength: 2000, default: '' },
    team: { type: mongoose.Schema.Types.ObjectId, ref: 'Team', required: true },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    members: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    status: {
      type: String,
      enum: ['planning', 'active', 'on_hold', 'completed', 'archived'],
      default: 'active',
    },
    startDate: { type: Date },
    endDate: { type: Date },
    taskSequence: { type: Number, default: 0 },

    icon: { type: String, trim: true, maxlength: 32, default: null },
    color: { type: String, trim: true, default: '#292524' },
    isPrivate: { type: Boolean, default: false },
    defaultPermission: {
      type: String,
      enum: SPACE_PERMISSION_VALUES,
      default: 'full_edit',
    },
    workflowTemplate: {
      type: String,
      enum: WORKFLOW_TEMPLATE_IDS,
      default: 'starter',
    },
    /**
     * Entity type:
     * - space → Spaces sidebar + Spaces dashboard
     * - project | list | folder | sprint | doc | form | whiteboard | dashboard → Projects
     * Legacy `list` from the old Space wizard is treated as space in the UI.
     */
    kind: {
      type: String,
      enum: [
        'space',
        'project',
        'list',
        'folder',
        'sprint',
        'doc',
        'form',
        'whiteboard',
        'dashboard',
      ],
      default: 'project',
    },
    statuses: {
      type: [statusSchema],
      default: () => defaultWorkflow.statuses.map((s) => ({ ...s })),
    },
    defaultViews: {
      type: [{ type: String, enum: SPACE_VIEW_VALUES }],
      default: () => [...defaultWorkflow.defaultViews],
    },
    clickApps: {
      type: [String],
      default: () => [...defaultWorkflow.clickApps],
    },
    activeView: {
      type: String,
      enum: SPACE_VIEW_VALUES,
      default: 'list',
    },
  },
  { timestamps: true }
);

projectSchema.index({ team: 1 });
projectSchema.index({ key: 1 }, { unique: true });
projectSchema.index({ owner: 1 });

module.exports = mongoose.model('Project', projectSchema);
