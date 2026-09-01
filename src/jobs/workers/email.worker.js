const env = require('../../config/env');
const logger = require('../../config/logger');
const { sendMail } = require('../../emails/mailer.util');
const { notificationEmail, welcomeEmail, inviteEmail } = require('../../emails/templates');
const { ensureLiveEmailUrl } = require('../../utils/clientUrl.util');
const {
  getQueueConnection,
  isValidRedisUrl,
  resolveRedisUrl,
} = require('../../config/redisConnection');

const redisEnabled = env.REDIS_ENABLED === true || env.REDIS_ENABLED === 'true';

const TEMPLATE_RENDERERS = {
  notification: notificationEmail,
  welcome: welcomeEmail,
  invite: inviteEmail,
};

const SUBJECTS = {
  notification: 'You have a new update',
  welcome: 'Welcome to BIWORKSPACE',
  invite: 'You are invited to BIWORKSPACE',
};

function sanitizeEmailData(template, data) {
  const next = { ...data };
  if (next.actionUrl) next.actionUrl = ensureLiveEmailUrl(next.actionUrl);
  if (next.loginUrl) next.loginUrl = ensureLiveEmailUrl(next.loginUrl, '/login');
  if (next.acceptUrl) next.acceptUrl = ensureLiveEmailUrl(next.acceptUrl, '/accept-invite');
  if (next.resetUrl) next.resetUrl = ensureLiveEmailUrl(next.resetUrl, '/reset-password');
  return next;
}

function startEmailWorker() {
  if (!redisEnabled) {
    logger.info('Email worker skipped (Redis disabled)');
    return null;
  }

  try {
    const url = resolveRedisUrl();
    if (!isValidRedisUrl(url)) {
      logger.warn('Email worker skipped (invalid Redis URL)');
      return null;
    }

    const { Worker } = require('bullmq');

    const worker = new Worker(
      'email',
      async (job) => {
        const { template, data } = job.data;
        const render = TEMPLATE_RENDERERS[template];
        if (!render) throw new Error(`Unknown email template: ${template}`);
        const safeData = sanitizeEmailData(template, data);

        await sendMail({
          to: safeData.to,
          subject: safeData.subject || SUBJECTS[template],
          html: render(safeData),
        });
      },
      {
        connection: getQueueConnection(),
        concurrency: 5,
      }
    );

    worker.on('ready', () => logger.info('Email worker ready (Upstash Redis)'));
    worker.on('completed', (job) => logger.debug(`Email job ${job.id} sent`));
    worker.on('failed', (job, err) =>
      logger.error(`Email job ${job?.id} failed: ${err.message}`)
    );
    worker.on('error', (err) => logger.warn(`Email worker error: ${err.message}`));

    return worker;
  } catch (err) {
    logger.warn(`Email worker failed to start: ${err.message}`);
    return null;
  }
}

module.exports = startEmailWorker;
