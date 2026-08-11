const BaseRepository = require('./base.repository');
const AuditLog = require('../models/auditLog.model');

class AuditLogRepository extends BaseRepository {
  constructor() {
    super(AuditLog);
  }
}

module.exports = new AuditLogRepository();
