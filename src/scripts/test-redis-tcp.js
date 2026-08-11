require('dotenv').config();

const { getQueueConnection } = require('../config/redisConnection');

async function main() {
  const Redis = require('ioredis');
  const conn = getQueueConnection();
  console.log('Connecting BullMQ/ioredis to:', conn.url.replace(/:[^:@]+@/, ':***@'));

  const client = new Redis(conn.url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });

  client.on('error', (err) => console.error('Redis error:', err.message));

  const pong = await client.ping();
  console.log('PING:', pong);
  await client.quit();
  process.exit(pong === 'PONG' ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
