const { z } = require('zod');

const createTeamSchema = z.object({
  body: z.object({
    name: z.string().trim().min(2).max(100),
    description: z.string().trim().max(500).optional(),
    department: z.string().length(24),
    lead: z.string().length(24),
    members: z.array(z.string().length(24)).optional(),
  }),
});

const updateTeamSchema = z.object({
  body: createTeamSchema.shape.body.partial(),
  params: z.object({ id: z.string().length(24) }),
});

module.exports = { createTeamSchema, updateTeamSchema };
