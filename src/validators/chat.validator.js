const { z } = require('zod');

const startDmSchema = z.object({
  body: z.object({
    userId: z.string().length(24),
  }),
});

const startTeamSchema = z.object({
  body: z.object({
    teamId: z.string().length(24),
  }),
});

const startDepartmentSchema = z.object({
  body: z.object({
    departmentId: z.string().length(24),
  }),
});

const startTaskSchema = z.object({
  body: z.object({
    taskId: z.string().length(24),
  }),
});

const sendChatMessageSchema = z.object({
  body: z
    .object({
      body: z.string().trim().max(5000).optional().default(''),
      mentions: z.array(z.string().length(24)).optional(),
      shareLinks: z
        .array(
          z.object({
            url: z.string().trim().min(1).max(1000),
            label: z.string().trim().max(200).optional(),
            kind: z.enum(['task', 'project', 'conversation', 'external']).optional(),
            refId: z.string().length(24).optional().nullable(),
          })
        )
        .max(5)
        .optional(),
    })
    .refine(
      (data) => (data.body && data.body.trim().length > 0) || (data.shareLinks || []).length > 0,
      { message: 'Message body or share link is required' }
    ),
  params: z.object({
    id: z.string().length(24),
  }),
});

module.exports = {
  startDmSchema,
  startTeamSchema,
  startDepartmentSchema,
  startTaskSchema,
  sendChatMessageSchema,
};
