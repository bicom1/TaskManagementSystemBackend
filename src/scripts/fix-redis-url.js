/**
 * Fix corrupted REDIS_URL using Upstash REST credentials.
 * Run: node src/scripts/fix-redis-url.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '../../.env');
let text = fs.readFileSync(envPath, 'utf8').replace(/^\uFEFF/, '');

const rest = (process.env.UPSTASH_REDIS_REST_URL || '').trim();
const token = (process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
if (!rest || !token) {
  console.error('Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN');
  process.exit(1);
}

const host = rest.replace(/^https?:\/\//i, '').replace(/\/$/, '');
const redisUrl = `rediss://default:${encodeURIComponent(token)}@${host}:6379`;

try {
  // eslint-disable-next-line no-new
  new URL(redisUrl);
} catch (e) {
  console.error('Built REDIS_URL is still invalid:', e.message);
  process.exit(1);
}

const line = `REDIS_URL=${redisUrl}`;
if (/^REDIS_URL=/m.test(text)) {
  text = text.replace(/^REDIS_URL=.*$/m, line);
} else {
  text = `${text.trimEnd()}\n${line}\n`;
}

fs.writeFileSync(envPath, text, 'utf8');
console.log('REDIS_URL fixed for host:', host);

const { resolveRedisUrl, isValidRedisUrl } = require('../config/redisConnection');
// Re-load won't pick new env in same process for env.js cache — validate built string
console.log('valid=', isValidRedisUrl(redisUrl));
