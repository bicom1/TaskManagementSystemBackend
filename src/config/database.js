const mongoose = require('mongoose');
const env = require('./env');
const logger = require('./logger');

async function connectDB() {
  mongoose.set('strictQuery', true);
  mongoose.set('autoIndex', true);

  const isProd = env.NODE_ENV === 'production';

  try {
    await mongoose.connect(env.MONGO_URI, {
      maxPoolSize: isProd ? 20 : 10,
      minPoolSize: isProd ? 2 : 0,
      maxIdleTimeMS: 30_000,
      serverSelectionTimeoutMS: 8_000,
      socketTimeoutMS: 45_000,
      compressors: ['zlib'],
    });
    logger.info('MongoDB connected');
  } catch (err) {
    logger.error('MongoDB connection failed', err);
    process.exit(1);
  }

  mongoose.connection.on('disconnected', () => {
    logger.warn('MongoDB disconnected');
  });
}

module.exports = connectDB;
