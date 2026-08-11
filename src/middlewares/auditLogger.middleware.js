const auditLogRepository = require('../repositories/auditLog.repository');
const logger = require('../config/logger');

/**
 * Fires after the response is sent, so it never adds latency to the
 * request itself. Only logs mutating methods to keep the collection lean —
 * GETs are noisy and rarely useful for an audit trail.
 */
function auditLogger(req, res, next) {
  const start = Date.now();

  res.on('finish', () => {
    if (req.method === 'GET') return;

    auditLogRepository
      .create({
        user: req.user?.id ?? null,
        method: req.method,
        route: req.originalUrl,
        statusCode: res.statusCode,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        durationMs: Date.now() - start,
      })
      .catch((err) => logger.warn(`Audit log write failed: ${err.message}`));
  });

  next();
}

module.exports = auditLogger;
