const { z } = require('zod');
const {
  MAX_LINKS_PER_MESSAGE,
  MAX_FILES_PER_MESSAGE,
} = require('../constants/chat.constant');

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

const shareLinkSchema = z.object({
  url: z.string().trim().min(1).max(1000),
  label: z.string().trim().max(200).optional(),
  kind: z.enum(['task', 'project', 'conversation', 'external']).optional(),
  refId: z.string().length(24).optional().nullable(),
});

const sendChatMessageSchema = z.object({
  body: z
    .object({
      body: z.string().trim().max(5000).optional().default(''),
      mentions: z.array(z.string().length(24)).optional(),
      shareLinks: z.array(shareLinkSchema).max(MAX_LINKS_PER_MESSAGE).optional(),
      /** Present when files already uploaded client-side as JSON (rare); usually multer */
      attachmentCount: z.coerce.number().int().min(0).max(MAX_FILES_PER_MESSAGE).optional(),
    })
    .passthrough(),
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
