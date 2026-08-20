const { z } = require('zod');

const linkSchema = z.object({
  url: z.string().trim().url().max(2000),
  title: z.string().trim().max(200).optional().default(''),
});

const createCommentSchema = z.object({
  body: z.object({
    taskId: z.string().length(24),
    content: z.string().trim().max(3000).optional().default(''),
    mentions: z.array(z.string().length(24)).optional().default([]),
    links: z.array(linkSchema).max(10).optional().default([]),
    attachments: z
      .array(
        z.object({
          url: z.string().url(),
          publicId: z.string().min(1),
          fileName: z.string().min(1),
          fileType: z.string().optional(),
        })
      )
      .max(5)
      .optional()
      .default([]),
  }),
});

const updateCommentSchema = z.object({
  body: z.object({ content: z.string().trim().min(1).max(3000) }),
  params: z.object({ id: z.string().length(24) }),
});

module.exports = { createCommentSchema, updateCommentSchema, linkSchema };
