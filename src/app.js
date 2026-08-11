require('express-async-errors'); // must be required before routes are loaded

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const mongoSanitize = require('express-mongo-sanitize');
const rateLimit = require('express-rate-limit');
const swaggerUi = require('swagger-ui-express');

const env = require('./config/env');
const swaggerSpec = require('./config/swagger');
const logger = require('./config/logger');
const routes = require('./routes');
const auditLogger = require('./middlewares/auditLogger.middleware');
const errorHandler = require('./middlewares/error.middleware');
const ApiError = require('./utils/ApiError.util');

const app = express();

app.use(helmet());
app.use(
  cors({
    origin(origin, callback) {
      const allowed = new Set([
        env.CLIENT_URL,
        'http://localhost:5173',
        'http://127.0.0.1:5173',
      ]);
      if (!origin || allowed.has(origin)) {
        return callback(null, true);
      }
      return callback(new Error(`CORS blocked for origin: ${origin}`));
    },
    credentials: true,
  })
);
app.use(compression());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser(env.COOKIE_SECRET));
app.use(mongoSanitize());
app.use(morgan(env.NODE_ENV === 'production' ? 'combined' : 'dev', { stream: { write: (msg) => logger.http(msg.trim()) } }));

// Global rate limit as a baseline; auth routes layer a tighter one on top
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 500,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

app.use(auditLogger);

app.get('/health', (req, res) => res.status(200).json({ status: 'ok', uptime: process.uptime() }));

app.use('/uploads', express.static(require('path').join(process.cwd(), 'uploads')));

app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
app.use('/api/v1', routes);

app.use((req, res, next) => {
  next(ApiError.notFound(`Route not found: ${req.method} ${req.originalUrl}`));
});

app.use(errorHandler);

module.exports = app;
