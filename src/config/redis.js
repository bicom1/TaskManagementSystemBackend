const { Redis } = require('@upstash/redis');
const env = require('./env');
const logger = require('./logger');
const { resolveRedisUrl } = require('./redisConnection');

const redisEnabled =
  env.REDIS_ENABLED === true || env.REDIS_ENABLED === 'true';

let redis = null;

if (redisEnabled && env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
  redis = new Redis({
    url: env.UPSTASH_REDIS_REST_URL,
    token: env.UPSTASH_REDIS_REST_TOKEN,
  });
  logger.info('Upstash REST client initialized');
} else if (redisEnabled) {
  logger.warn('Redis enabled but UPSTASH_REDIS_REST_URL/TOKEN missing — cache disabled');
} else {
  logger.info('Redis disabled');
}

async function verifyRedisConnection() {
  if (!redis) return { ok: false, reason: 'disabled' };
  try {
    const pong = await redis.ping();
    return { ok: pong === 'PONG', reason: pong === 'PONG' ? 'connected' : `unexpected: ${pong}` };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

async function cacheOrFetch(key, ttlSeconds, fetcher) {
  if (redis) {
    try {
      const cached = await redis.get(key);
      if (cached) return cached;
    } catch (err) {
      logger.warn(`Cache read failed: ${err.message}`);
    }
  }

  const fresh = await fetcher();

  if (redis) {
    try {
      await redis.set(key, fresh, { ex: ttlSeconds });
    } catch (err) {
      logger.warn(`Cache write failed: ${err.message}`);
    }
  }

  return fresh;
}

async function invalidateByPrefix(prefix) {
  if (!redis) return;
  try {
    let cursor = '0';
    do {
      const [nextCursor, keys] = await redis.scan(cursor, { match: `${prefix}*`, count: 100 });
      if (keys.length) await redis.del(...keys);
      cursor = nextCursor;
    } while (cursor !== '0');
  } catch (err) {
    logger.warn(`Cache invalidation failed: ${err.message}`);
  }
}

module.exports = {
  redis,
  redisEnabled,
  resolveRedisUrl,
  verifyRedisConnection,
  cacheOrFetch,
  invalidateByPrefix,
};
