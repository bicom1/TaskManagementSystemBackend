const env = require('../../config/env');
const logger = require('../../config/logger');
const { getQueueConnection, isValidRedisUrl, resolveRedisUrl } = require('../../config/redisConnection');

const redisEnabled = env.REDIS_ENABLED === true || env.REDIS_ENABLED === 'true';

let emailQueue = null;

if (redisEnabled) {
  try {
    const url = resolveRedisUrl();
    if (!isValidRedisUrl(url)) {
      throw new Error('Redis URL invalid — email queue disabled (direct SMTP still used)');
    }
    const { Queue } = require('bullmq');
    emailQueue = new Queue('email', {
      connection: getQueueConnection(),
    });
    logger.info('Email queue connected to Upstash Redis');
  } catch (err) {
    emailQueue = null;
    logger.warn(`Email queue init failed: ${err.message}`);
  }
}

/**
 * @param {'notification'|'welcome'|'invite'} template
 * @param {object} data
 */
async function enqueueEmail(template, data) {
  if (!emailQueue) {
    logger.debug(`Email skipped (queue unavailable): ${template}`);
    return;
  }

  try {
    await emailQueue.add(
      template,
      { template, data },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 100,
        removeOnFail: 500,
      }
    );
  } catch (err) {
    logger.warn(`Failed to enqueue email (${template}): ${err.message}`);
  }
}

module.exports = { emailQueue, enqueueEmail };
