/**
 * ClickUp-style Space (project) workflow templates.
 * Statuses map to the global task status enum used by the board engine.
 */

const SPACE_PERMISSIONS = Object.freeze({
  FULL_EDIT: 'full_edit',
  EDIT: 'edit',
  COMMENT: 'comment',
  VIEW: 'view',
});

const SPACE_VIEWS = Object.freeze({
  CHANNEL: 'channel',
  LIST: 'list',
  BOARD: 'board',
});

const SPACE_CLICK_APPS = Object.freeze([
  'tags',
  'time_estimates',
  'priority',
  'time_tracking',
  'incomplete_warning',
  'assignees',
  'due_dates',
  'checklists',
]);

const STATUS_PRESETS = Object.freeze({
  starter: [
    { key: 'todo', label: 'TO DO', color: '#9ca3af' },
    { key: 'in_progress', label: 'IN PROGRESS', color: '#7c3aed' },
    { key: 'done', label: 'COMPLETE', color: '#22c55e' },
  ],
  marketing: [
    { key: 'backlog', label: 'IDEAS', color: '#9ca3af' },
    { key: 'todo', label: 'PLANNED', color: '#3b82f6' },
    { key: 'in_progress', label: 'IN PROGRESS', color: '#7c3aed' },
    { key: 'in_review', label: 'REVIEW', color: '#f59e0b' },
    { key: 'done', label: 'PUBLISHED', color: '#22c55e' },
  ],
  project_management: [
    { key: 'backlog', label: 'BACKLOG', color: '#9ca3af' },
    { key: 'todo', label: 'TO DO', color: '#3b82f6' },
    { key: 'in_progress', label: 'IN PROGRESS', color: '#7c3aed' },
    { key: 'in_review', label: 'IN REVIEW', color: '#f59e0b' },
    { key: 'done', label: 'DONE', color: '#22c55e' },
  ],
  product_engineering: [
    { key: 'backlog', label: 'BACKLOG', color: '#9ca3af' },
    { key: 'todo', label: 'READY', color: '#3b82f6' },
    { key: 'in_progress', label: 'IN PROGRESS', color: '#7c3aed' },
    { key: 'in_review', label: 'CODE REVIEW', color: '#f59e0b' },
    { key: 'done', label: 'SHIPPED', color: '#22c55e' },
  ],
});

const WORKFLOW_TEMPLATES = Object.freeze({
  starter: {
    id: 'starter',
    name: 'Starter',
    description: 'For everyday tasks.',
    defaultViews: [SPACE_VIEWS.CHANNEL, SPACE_VIEWS.LIST, SPACE_VIEWS.BOARD],
    statuses: STATUS_PRESETS.starter,
    clickApps: [
      'tags',
      'priority',
      'assignees',
      'due_dates',
      'time_estimates',
      'time_tracking',
      'incomplete_warning',
      'checklists',
    ],
  },
  marketing: {
    id: 'marketing',
    name: 'Marketing Teams',
    description: 'Run effective campaigns.',
    defaultViews: [SPACE_VIEWS.CHANNEL, SPACE_VIEWS.LIST, SPACE_VIEWS.BOARD],
    statuses: STATUS_PRESETS.marketing,
    clickApps: [
      'tags',
      'priority',
      'assignees',
      'due_dates',
      'time_estimates',
      'checklists',
    ],
  },
  project_management: {
    id: 'project_management',
    name: 'Project Management',
    description: 'Plan, manage, and execute projects.',
    defaultViews: [SPACE_VIEWS.CHANNEL, SPACE_VIEWS.LIST, SPACE_VIEWS.BOARD],
    statuses: STATUS_PRESETS.project_management,
    clickApps: [...SPACE_CLICK_APPS],
  },
  product_engineering: {
    id: 'product_engineering',
    name: 'Product + Engineering',
    description: 'Streamline your product lifecycle.',
    defaultViews: [SPACE_VIEWS.CHANNEL, SPACE_VIEWS.LIST, SPACE_VIEWS.BOARD],
    statuses: STATUS_PRESETS.product_engineering,
    clickApps: [...SPACE_CLICK_APPS],
  },
});

function getWorkflowTemplate(id = 'starter') {
  return WORKFLOW_TEMPLATES[id] || WORKFLOW_TEMPLATES.starter;
}

function generateProjectKey(name) {
  const words = String(name || '')
    .trim()
    .split(/[\s\-_]+/)
    .filter(Boolean);
  let key = words
    .map((w) => w[0])
    .join('')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 6);
  if (key.length < 2) {
    key = String(name || 'SP')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 4);
  }
  if (key.length < 2) key = 'SP';
  return key;
}

module.exports = {
  SPACE_PERMISSIONS,
  SPACE_PERMISSION_VALUES: Object.values(SPACE_PERMISSIONS),
  SPACE_VIEWS,
  SPACE_VIEW_VALUES: Object.values(SPACE_VIEWS),
  SPACE_CLICK_APPS,
  WORKFLOW_TEMPLATES,
  WORKFLOW_TEMPLATE_IDS: Object.keys(WORKFLOW_TEMPLATES),
  getWorkflowTemplate,
  generateProjectKey,
};
