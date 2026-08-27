const http = require('http');
const app = require('./app');
const env = require('./config/env');
const logger = require('./config/logger');
const connectDB = require('./config/database');
const { initSocket } = require('./socket/socket');
const { verifyRedisConnection, resolveRedisUrl } = require('./config/redis');
const { verifyEmailConnection, getActiveEmailProvider } = require('./emails/mailer.util');
const startEmailWorker = require('./jobs/workers/email.worker');
const startDueSoonCron = require('./jobs/cron/dueSoon.cron');

async function start() {
  await connectDB();

  const redisEnabled = env.REDIS_ENABLED === true || env.REDIS_ENABLED === 'true';
  if (redisEnabled) {
    const redisCheck = await verifyRedisConnection();
    if (redisCheck.ok) {
      logger.info('Upstash Redis REST connected');
    } else {
      logger.warn(`Upstash Redis REST check failed: ${redisCheck.reason}`);
    }
    logger.info(`BullMQ Redis URL: ${resolveRedisUrl().replace(/:[^:@]+@/, ':***@')}`);
  }

  const emailCheck = await verifyEmailConnection();
  if (emailCheck.ok) {
    logger.info(`Email ready via ${emailCheck.provider || getActiveEmailProvider()} (${emailCheck.reason})`);
  } else {
    logger.warn(`Email not ready: ${emailCheck.reason}`);
    logger.warn(
      'Set SMTP_HOST/SMTP_USER/SMTP_PASS_B64 (cPanel) or RESEND_API_KEY on this host, then restart. ' +
        'Render often blocks outbound SMTP — if /health/email fails on Render, use Resend with a verified domain.'
    );
  }

  const httpServer = http.createServer(app);
  initSocket(httpServer);

  startEmailWorker();
  startDueSoonCron();

  httpServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      logger.error(`Port ${env.PORT} is already in use. Stop the other process or change PORT in .env`);
      process.exit(1);
    }
    throw err;
  });

  httpServer.listen(env.PORT, () => {
    logger.info(`Server running on port ${env.PORT} [${env.NODE_ENV}]`);
    logger.info(`Swagger docs at http://localhost:${env.PORT}/api-docs`);
  });

  const shutdown = (signal) => {
    logger.info(`${signal} received — shutting down gracefully`);
    httpServer.close(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch((err) => {
  logger.error('Failed to start server', err);
  process.exit(1);
});
