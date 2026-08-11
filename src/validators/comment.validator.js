const { z } = require('zod');

const createCommentSchema = z.object({
  body: z.object({
    taskId: z.string().length(24),
    content: z.string().trim().min(1).max(3000),
    mentions: z.array(z.string().length(24)).optional(),
  }),
});

const updateCommentSchema = z.object({
  body: z.object({ content: z.string().trim().min(1).max(3000) }),
  params: z.object({ id: z.string().length(24) }),
});

module.exports = { createCommentSchema, updateCommentSchema };
