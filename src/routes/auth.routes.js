// const { Router } = require('express');
// const rateLimit = require('express-rate-limit');
// const authController = require('../controllers/auth.controller');
// const authenticate = require('../middlewares/auth.middleware');
// const validate = require('../middlewares/validate.middleware');
// const { registerSchema, loginSchema } = require('../validators/auth.validator');

// const router = Router();

// // Tighter limiter on credential-guessing-prone endpoints
// const authLimiter = rateLimit({
//   windowMs: 15 * 60 * 1000,
//   max: 10,
//   message: { success: false, message: 'Too many attempts, please try again later' },
//   standardHeaders: true,
//   legacyHeaders: false,
// });

// /**
//  * @swagger
//  * /auth/register:
//  *   post:
//  *     summary: Register a new user
//  *     tags: [Auth]
//  */
// router.post('/register', authLimiter, validate(registerSchema), authController.register);

// /**
//  * @swagger
//  * /auth/login:
//  *   post:
//  *     summary: Login with email and password
//  *     tags: [Auth]
//  */
// router.post('/login', authLimiter, validate(loginSchema), authController.login);

// /**
//  * @swagger
//  * /auth/refresh:
//  *   post:
//  *     summary: Exchange refresh token cookie for a new access token
//  *     tags: [Auth]
//  */
// router.post('/refresh', authController.refresh);

// /**
//  * @swagger
//  * /auth/logout:
//  *   post:
//  *     summary: Clear refresh token cookie
//  *     tags: [Auth]
//  */
// router.post('/logout', authController.logout);

// /**
//  * @swagger
//  * /auth/logout-all:
//  *   post:
//  *     summary: Invalidate all refresh tokens for the current user
//  *     tags: [Auth]
//  */
// router.post('/logout-all', authenticate, authController.logoutAllDevices);

// module.exports = router;
const { Router } = require('express');
const rateLimit = require('express-rate-limit');
const authController = require('../controllers/auth.controller');
const authenticate = require('../middlewares/auth.middleware');
const validate = require('../middlewares/validate.middleware');
const { registerSchema, loginSchema, googleAuthSchema, forgotPasswordSchema, resetPasswordSchema } = require('../validators/auth.validator');

const router = Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: {
    success: false,
    message: 'Too many attempts, please try again later',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * @swagger
 * /auth/register:
 *   post:
 *     summary: Register a new user
 *     tags:
 *       - Auth
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - firstName
 *               - lastName
 *               - email
 *               - password
 *             properties:
 *               firstName:
 *                 type: string
 *                 example: Muhammad
 *               lastName:
 *                 type: string
 *                 example: Maaz
 *               email:
 *                 type: string
 *                 example: maaz@example.com
 *               password:
 *                 type: string
 *                 example: Password@123
 *               phone:
 *                 type: string
 *                 example: "+923001234567"
 *               role:
 *                 type: string
 *                 example: employee
 *     responses:
 *       201:
 *         description: User registered successfully
 *       400:
 *         description: Validation error
 */
router.post(
  '/register',
  authLimiter,
  validate(registerSchema),
  authController.register
);

/**
 * @swagger
 * /auth/login:
 *   post:
 *     summary: Login with email and password
 *     tags:
 *       - Auth
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - password
 *             properties:
 *               email:
 *                 type: string
 *                 example: maaz@example.com
 *               password:
 *                 type: string
 *                 example: Password@123
 *     responses:
 *       200:
 *         description: Login successful
 *       401:
 *         description: Invalid credentials
 */
router.post(
  '/login',
  authLimiter,
  validate(loginSchema),
  authController.login
);

/**
 * @swagger
 * /auth/forgot-password:
 *   post:
 *     summary: Request a password reset email
 *     tags:
 *       - Auth
 */
router.post(
  '/forgot-password',
  authLimiter,
  validate(forgotPasswordSchema),
  authController.forgotPassword
);

/**
 * @swagger
 * /auth/reset-password:
 *   post:
 *     summary: Reset password with token from email
 *     tags:
 *       - Auth
 */
router.post(
  '/reset-password',
  authLimiter,
  validate(resetPasswordSchema),
  authController.resetPassword
);

/**
 * @swagger
 * /auth/google:
 *   get:
 *     summary: Start Google OAuth (browser redirect)
 *     tags:
 *       - Auth
 *   post:
 *     summary: Sign in with Google ID token (GIS)
 *     tags:
 *       - Auth
 */
router.get('/google', authController.googleStart);

router.get('/google/callback', authController.googleCallback);

router.post(
  '/google',
  authLimiter,
  validate(googleAuthSchema),
  authController.googleAuth
);

/**
 * @swagger
 * /auth/refresh:
 *   post:
 *     summary: Exchange refresh token for a new access token
 *     tags:
 *       - Auth
 *     responses:
 *       200:
 *         description: Token refreshed successfully
 */
router.post('/refresh', authController.refresh);

/**
 * @swagger
 * /auth/logout:
 *   post:
 *     summary: Logout current user
 *     tags:
 *       - Auth
 *     responses:
 *       200:
 *         description: Logged out successfully
 */
router.post('/logout', authController.logout);

/**
 * @swagger
 * /auth/logout-all:
 *   post:
 *     summary: Logout from all devices
 *     tags:
 *       - Auth
 *     security:
 *       - bearerAuth: []
 *     responses:  
 *       200:
 *         description: Logged out from all devices
 */
router.post('/logout-all', authenticate, authController.logoutAllDevices);

module.exports = router;