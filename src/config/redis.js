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
  logger.warn('Redis enabled but UPSTASH_REDIS_REST_URL/TOKEN missing — using memory cache');
} else {
  logger.info('Redis disabled — using in-process memory cache');
}

/** Local + live fallback when Upstash is off (Render cold starts still benefit). */
const memoryCache = new Map();
const MEMORY_MAX = 500;

function memoryGet(key) {
  const hit = memoryCache.get(key);
  if (!hit) return undefined;
  if (Date.now() > hit.exp) {
    memoryCache.delete(key);
    return undefined;
  }
  return hit.value;
}

function memorySet(key, value, ttlSeconds) {
  if (memoryCache.size > MEMORY_MAX) {
    const first = memoryCache.keys().next().value;
    memoryCache.delete(first);
  }
  memoryCache.set(key, { value, exp: Date.now() + ttlSeconds * 1000 });
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

let redisQuotaExhausted = false;

function isRedisQuotaError(err) {
  return /max requests limit exceeded/i.test(String(err?.message || err || ''));
}

function disableRedisForProcess(reason) {
  if (!redisQuotaExhausted) {
    redisQuotaExhausted = true;
    redis = null;
    logger.warn(`Redis disabled for this process: ${reason}`);
  }
}

async function cacheOrFetch(key, ttlSeconds, fetcher) {
  if (redis && !redisQuotaExhausted) {
    try {
      const cached = await redis.get(key);
      if (cached != null) return cached;
    } catch (err) {
      if (isRedisQuotaError(err)) disableRedisForProcess(err.message);
      else logger.warn(`Cache read failed: ${err.message}`);
    }
  } else {
    const mem = memoryGet(key);
    if (mem !== undefined) return mem;
  }

  const fresh = await fetcher();

  if (redis && !redisQuotaExhausted) {
    try {
      await redis.set(key, fresh, { ex: ttlSeconds });
    } catch (err) {
      if (isRedisQuotaError(err)) disableRedisForProcess(err.message);
      else logger.warn(`Cache write failed: ${err.message}`);
    }
  } else {
    memorySet(key, fresh, ttlSeconds);
  }

  return fresh;
}

async function invalidateByPrefix(prefix) {
  for (const key of [...memoryCache.keys()]) {
    if (String(key).startsWith(prefix)) memoryCache.delete(key);
  }
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
