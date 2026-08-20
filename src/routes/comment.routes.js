const { Router } = require('express');
const controller = require('../controllers/comment.controller');
const authenticate = require('../middlewares/auth.middleware');
const validate = require('../middlewares/validate.middleware');
const upload = require('../middlewares/upload.middleware');
const { createCommentSchema, updateCommentSchema } = require('../validators/comment.validator');

const router = Router();
router.use(authenticate);

router.get('/task/:taskId', controller.listByTask);
router.post(
  '/',
  upload.array('files', 5),
  controller.normalizeCommentBody,
  validate(createCommentSchema),
  controller.create
);
router.patch('/:id', validate(updateCommentSchema), controller.update);
router.delete('/:id', controller.remove);

module.exports = router;
