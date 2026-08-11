const { z } = require('zod');

const inviteUserSchema = z.object({
  body: z.object({
    email: z.string().trim().email('Enter a valid email'),
    name: z.string().trim().min(2).max(100).optional(),
    role: z.enum(['dept_head', 'team_lead', 'executive', 'employee']).optional(),
    jobTitle: z.string().trim().max(100).optional(),
    department: z.string().length(24).optional(),
    /** Type a new or existing department name when not picking from the list */
    departmentName: z.string().trim().min(2).max(100).optional(),
    team: z.string().length(24).optional(),
    /** Type a new or existing team name within the department */
    teamName: z.string().trim().min(2).max(100).optional(),
    teamLead: z.string().length(24).optional(),
    setAsTeamLead: z.boolean().optional(),
  }),
});

const updateMeSchema = z.object({
  body: z
    .object({
      name: z.string().trim().min(2).max(100).optional(),
      jobTitle: z.string().trim().max(100).nullable().optional(),
      avatarUrl: z
        .union([z.string().trim().url(), z.literal(''), z.null()])
        .optional(),
    })
    .refine((data) => Object.keys(data).length > 0, {
      message: 'Provide at least one field to update',
    }),
});

const changePasswordSchema = z.object({
  body: z.object({
    currentPassword: z.string().min(1, 'Current password is required'),
    newPassword: z
      .string()
      .min(8, 'Password must be at least 8 characters')
      .regex(/[A-Z]/, 'Password must contain an uppercase letter')
      .regex(/[0-9]/, 'Password must contain a number'),
  }),
});

const updateUserSchema = z.object({
  body: z
    .object({
      name: z.string().trim().min(2).max(100).optional(),
      jobTitle: z.string().trim().max(100).nullable().optional(),
      role: z.enum(['dept_head', 'team_lead', 'executive', 'employee']).optional(),
      department: z.string().length(24).nullable().optional(),
      team: z.string().length(24).optional(),
      isActive: z.boolean().optional(),
    })
    .refine((data) => Object.keys(data).length > 0, {
      message: 'Provide at least one field to update',
    }),
  params: z.object({ id: z.string().length(24) }),
});

const acceptInviteSchema = z.object({
  body: z.object({
    token: z.string().min(20),
    password: z
      .string()
      .min(8, 'Password must be at least 8 characters')
      .regex(/[A-Z]/, 'Password must contain an uppercase letter')
      .regex(/[0-9]/, 'Password must contain a number'),
    name: z.string().trim().min(2).max(100).optional(),
  }),
});

module.exports = {
  inviteUserSchema,
  updateMeSchema,
  changePasswordSchema,
  updateUserSchema,
  acceptInviteSchema,
};
