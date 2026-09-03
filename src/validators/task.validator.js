const { z } = require('zod');
const { TASK_STATUS_VALUES, TASK_PRIORITY_VALUES } = require('../constants/task.constant');

const objectId = z.string().length(24);

/** Accept raw ids or `{ _id }` objects from clients */
const assigneeId = z.preprocess((value) => {
  if (value && typeof value === 'object') return String(value._id || value.id || '');
  return value == null ? value : String(value);
}, objectId);

const checklistItemSchema = z.object({
  _id: objectId.optional(),
  text: z.string().trim().min(1).max(500),
  isDone: z.boolean().optional(),
  doneAt: z.coerce.date().nullable().optional(),
  createdBy: objectId.optional(),
});

const recurrenceSchema = z
  .object({
    enabled: z.boolean().optional(),
    frequency: z.enum(['daily', 'weekly', 'monthly']).optional(),
    nextRunAt: z.coerce.date().nullable().optional(),
  })
  .optional();

const createTaskSchema = z.object({
  body: z.object({
    title: z.string().trim().min(2).max(200),
    description: z.string().trim().max(5000).optional().nullable(),
    project: objectId,
    parentTask: objectId.optional().nullable(),
    status: z.enum(TASK_STATUS_VALUES).optional(),
    priority: z.enum(TASK_PRIORITY_VALUES).optional(),
    assignees: z.array(assigneeId).optional(),
    dueDate: z.coerce.date().optional().nullable(),
    labels: z.array(z.string().trim().min(1).max(40)).optional(),
    checklist: z.array(checklistItemSchema).optional(),
    blockedBy: z.array(objectId).optional(),
    relatedTasks: z.array(objectId).optional(),
    estimateHours: z.number().min(0).nullable().optional(),
    loggedHours: z.number().min(0).nullable().optional(),
    recurrence: recurrenceSchema,
  }),
});

const updateTaskSchema = z.object({
  body: createTaskSchema.shape.body.partial().omit({ project: true }).extend({
    advanceWorkflow: z.boolean().optional(),
  }),
  params: z.object({ id: objectId }),
});

const moveTaskSchema = z.object({
  body: z.object({
    status: z.enum(TASK_STATUS_VALUES),
    position: z.number(),
  }),
  params: z.object({ id: objectId }),
});

module.exports = { createTaskSchema, updateTaskSchema, moveTaskSchema };
