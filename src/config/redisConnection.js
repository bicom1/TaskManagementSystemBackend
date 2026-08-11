const env = require('./env');
const logger = require('./logger');

function isValidRedisUrl(value) {
  if (!value || typeof value !== 'string') return false;
  try {
    const u = new URL(value);
    return (u.protocol === 'redis:' || u.protocol === 'rediss:') && Boolean(u.hostname);
  } catch {
    return false;
  }
}

/** Build Upstash TCP URL for BullMQ / ioredis from REST credentials. */
function buildUpstashTcpUrl() {
  const restUrl = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  if (!restUrl || !token) return null;

  const host = String(restUrl)
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/$/, '');
  if (!host) return null;

  return `rediss://default:${encodeURIComponent(token)}@${host}:6379`;
}

function resolveRedisUrl() {
  const configured = String(env.REDIS_URL || '').trim();

  if (configured && configured !== 'redis://localhost:6379' && isValidRedisUrl(configured)) {
    return configured;
  }

  if (configured && configured !== 'redis://localhost:6379' && !isValidRedisUrl(configured)) {
    logger.warn('REDIS_URL is invalid — rebuilding from UPSTASH_REDIS_REST_* credentials');
  }

  const built = buildUpstashTcpUrl();
  if (built && isValidRedisUrl(built)) {
    return built;
  }

  return isValidRedisUrl(configured) ? configured : 'redis://localhost:6379';
}

function getQueueConnection() {
  const url = resolveRedisUrl();
  if (!isValidRedisUrl(url)) {
    throw new Error(`Invalid Redis URL for email queue`);
  }
  return {
    url,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  };
}

module.exports = { resolveRedisUrl, getQueueConnection, isValidRedisUrl, buildUpstashTcpUrl };
