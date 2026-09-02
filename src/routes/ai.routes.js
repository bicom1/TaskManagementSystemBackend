const { Router } = require('express');
const rateLimit = require('express-rate-limit');
const authenticate = require('../middlewares/auth.middleware');
const validate = require('../middlewares/validate.middleware');
const aiController = require('../controllers/ai.controller');
const { chatSchema } = require('../validators/ai.validator');

const router = Router();

const aiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  message: { success: false, message: 'Too many AI requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

router.use(authenticate);
router.use(aiLimiter);

router.post('/chat', validate(chatSchema), aiController.chat);

module.exports = router;
