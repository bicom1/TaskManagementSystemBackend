const BaseRepository = require('./base.repository');
const Department = require('../models/department.model');

class DepartmentRepository extends BaseRepository {
  constructor() {
    super(Department);
  }
}

module.exports = new DepartmentRepository();
