const { z } = require('zod');
require('dotenv').config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(5000),

  MONGO_URI: z.string().min(1, 'MONGO_URI is required'),

  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),

  COOKIE_SECRET: z.string().min(1),
  CLIENT_URL: z.string().url().default('http://localhost:5173'),
  /** Optional explicit live frontend URL for emails when CLIENT_URL is wrong on the server */
  PUBLIC_APP_URL: z.string().url().optional(),

  REDIS_URL: z.string().default('redis://localhost:6379'),
  REDIS_ENABLED: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .optional()
    .default('false'),

  UPSTASH_REDIS_REST_URL: z.string().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional(),

  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  /** Base64 of the SMTP password — use when the password starts with # or has special chars */
  SMTP_PASS_B64: z.string().optional(),
  EMAIL_FROM: z.string().default('BIWORKSPACE <noreply@bicomworkspace.com>'),
  /** resend | smtp | brevo | auto — prefer resend until bicomworkspace.com DNS is verified */
  EMAIL_PROVIDER: z.string().optional().default('resend'),
  /** Recommended for Gmail delivery: https://resend.com (verify bicomworkspace.com) */
  RESEND_API_KEY: z.string().optional(),
  /** Alternative: https://www.brevo.com */
  BREVO_API_KEY: z.string().optional(),

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().url().optional(),

  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL_MAX: z.string().default('gpt-4o'),
  OPENAI_MODEL_FAST: z.string().default('gpt-4o-mini'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('❌ Invalid environment variables:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

module.exports = parsed.data;
