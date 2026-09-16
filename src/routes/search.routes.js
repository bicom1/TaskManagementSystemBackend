const { Router } = require('express');
const controller = require('../controllers/search.controller');
const authenticate = require('../middlewares/auth.middleware');
const { loadActorContext } = require('../middlewares/permission.middleware');

const router = Router();
router.use(authenticate);
router.use(loadActorContext);

router.get('/', controller.search);

module.exports = router;
