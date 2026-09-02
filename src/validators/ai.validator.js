const { z } = require('zod');

const chatSchema = z.object({
  body: z.object({
    message: z.string().trim().min(1).max(8000),
    model: z.enum(['max', 'fast']).optional().default('max'),
    messages: z
      .array(
        z.object({
          role: z.enum(['user', 'assistant']),
          content: z.string().max(8000),
        })
      )
      .max(20)
      .optional()
      .default([]),
  }),
});

module.exports = { chatSchema };
