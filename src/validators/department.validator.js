const { z } = require('zod');

const departmentCodeSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(50)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'Use lowercase letters, numbers, _ or -');

const createDepartmentSchema = z.object({
  body: z.object({
    name: z.string().trim().min(2).max(100),
    code: departmentCodeSchema,
    description: z.string().trim().max(500).optional(),
    head: z.string().length(24).optional(),
  }),
});

const updateDepartmentSchema = z.object({
  body: createDepartmentSchema.shape.body.partial(),
  params: z.object({ id: z.string().length(24) }),
});

module.exports = { createDepartmentSchema, updateDepartmentSchema };
