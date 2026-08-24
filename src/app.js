require('express-async-errors');

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

// Required on Render (proxy) so secure cookies + rate-limit IPs work
app.set('trust proxy', 1);

app.use(helmet());
app.use(
  cors({
    origin(origin, callback) {
      const allowed = new Set([
        env.CLIENT_URL,
        'https://task-management-system-frontend-z23.vercel.app',
        'http://localhost:5173',
        'http://127.0.0.1:5173',
      ]);

      const isVercelPreview =
        typeof origin === 'string' &&
        /^https:\/\/task-management-system-frontend[\w-]*\.vercel\.app$/i.test(origin);

      if (!origin || allowed.has(origin) || isVercelPreview) {
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

// Root is not an API page — return a small OK payload (stops Render/browser 404 noise)
app.get('/', (req, res) => {
  res.status(200).json({
    success: true,
    name: 'BI Workspace API',
    health: '/health',
    docs: '/api-docs',
    api: '/api/v1',
  });
});
app.head('/', (req, res) => res.sendStatus(200));

app.use('/uploads', express.static(require('path').join(process.cwd(), 'uploads')));

app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
app.use('/api/v1', routes);

app.use((req, res, next) => {
  next(ApiError.notFound(`Route not found: ${req.method} ${req.originalUrl}`));
});

app.use(errorHandler);

module.exports = app;
