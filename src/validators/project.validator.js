const { z } = require('zod');

const statusSchema = z.object({
  key: z.string().trim().min(1).max(40),
  label: z.string().trim().min(1).max(40),
  color: z.string().trim().max(20).optional(),
});

/** Empty string / null → undefined so optional ObjectId fields don't fail .length(24) */
const optionalObjectId = z.preprocess(
  (val) => (val === '' || val === null || val === undefined ? undefined : val),
  z.string().length(24).optional()
);

const createProjectSchema = z.object({
  body: z.object({
    name: z.string().trim().min(2).max(150),
    key: z.string().trim().min(2).max(10).optional(),
    description: z.string().trim().max(2000).optional().or(z.literal('')),
    team: optionalObjectId,
    owner: optionalObjectId,
    members: z.array(z.string().length(24)).optional(),
    startDate: z.coerce.date().optional(),
    endDate: z.coerce.date().optional(),
    icon: z.preprocess(
      (val) => (val === '' ? null : val),
      z.string().trim().max(32).nullable().optional()
    ),
    color: z.string().trim().max(20).optional(),
    isPrivate: z.boolean().optional(),
    defaultPermission: z.enum(['full_edit', 'edit', 'comment', 'view']).optional(),
    workflowTemplate: z
      .enum(['starter', 'marketing', 'project_management', 'product_engineering'])
      .optional(),
    kind: z
      .enum([
        'space',
        'project',
        'list',
        'folder',
        'sprint',
        'doc',
        'form',
        'whiteboard',
        'dashboard',
      ])
      .optional(),
    statuses: z.array(statusSchema).min(1).max(12).optional(),
    defaultViews: z
      .array(z.enum(['channel', 'list', 'board']))
      .min(1)
      .max(8)
      .optional(),
    clickApps: z.array(z.string().trim().min(1).max(40)).optional(),
    activeView: z.enum(['channel', 'list', 'board']).optional(),
  }),
});

const updateProjectSchema = z.object({
  body: createProjectSchema.shape.body.partial().extend({
    status: z.enum(['planning', 'active', 'on_hold', 'completed', 'archived']).optional(),
  }),
  params: z.object({ id: z.string().length(24) }),
});

module.exports = { createProjectSchema, updateProjectSchema };
