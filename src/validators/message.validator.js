const { z } = require('zod');

const sendMessageSchema = z.object({
  body: z
    .object({
      to: z.string().length(24).optional(),
      department: z.string().length(24).optional(),
      team: z.string().length(24).optional(),
      subject: z.string().trim().min(2).max(200),
      body: z.string().trim().min(1).max(5000),
      parentMessage: z.string().length(24).optional(),
      type: z.enum(['query', 'reply', 'announcement']).optional(),
    })
    .refine((data) => data.to || data.department || data.team, {
      message: 'Provide to, department, or team',
    }),
});

const createTaskFromMessageSchema = z.object({
  body: z.object({
    projectId: z.string().length(24),
    title: z.string().trim().min(2).max(200).optional(),
  }),
  params: z.object({
    id: z.string().length(24),
  }),
});

module.exports = { sendMessageSchema, createTaskFromMessageSchema };
