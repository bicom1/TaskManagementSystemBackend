const departmentRepository = require('../repositories/department.repository');
const userRepository = require('../repositories/user.repository');
const notificationService = require('./notification.service');
const ApiError = require('../utils/ApiError.util');
const { NOTIFICATION_TYPES } = require('../constants/notification.constant');
const { ROLES, DEPARTMENT_PRESETS } = require('../constants/roles.constant');
const Department = require('../models/department.model');

class DepartmentService {
  /** Ensure SEO, Development, and UI/UX Designing exist so invite dropdown always has them */
  async ensureMainDepartments() {
    for (const preset of DEPARTMENT_PRESETS) {
      let existing = await Department.findOne({ code: preset.code });
      if (!existing) {
        // Legacy rows may have the right name but wrong/missing code
        const namePattern =
          preset.code === 'seo'
            ? /^seo$/i
            : preset.code === 'development'
              ? /develop/i
              : /(ui\s*\/?\s*ux|design)/i;
        existing = await Department.findOne({ name: namePattern });
      }
      if (existing) {
        await Department.findByIdAndUpdate(existing._id, {
          code: preset.code,
          name: preset.name,
          description: preset.description || existing.description,
          isActive: true,
        });
        continue;
      }
      await Department.create({
        code: preset.code,
        name: preset.name,
        description: preset.description,
        isActive: true,
      });
    }
  }

  async create(data, actorId) {
    const department = await departmentRepository.create(data);

    const superAdmins = await userRepository.findPaginated(
      { role: ROLES.SUPER_ADMIN, isActive: true },
      { page: 1, limit: 50 }
    );

    await Promise.all(
      (superAdmins.data || [])
        .filter((u) => u._id.toString() !== String(actorId))
        .map((admin) =>
          notificationService.notify({
            recipient: admin._id,
            sender: actorId,
            type: NOTIFICATION_TYPES.DEPARTMENT_CREATED,
            message: `New department created: ${department.name}`,
            entityType: 'Project',
            entityId: department._id,
            emailToo: true,
          })
        )
    );

    // Always notify the actor (confirmation in inbox)
    await notificationService.notify({
      recipient: actorId,
      sender: actorId,
      type: NOTIFICATION_TYPES.DEPARTMENT_CREATED,
      message: `Department "${department.name}" is now available`,
      entityType: 'Project',
      entityId: department._id,
    });

    return department;
  }

  async list({ page, limit }) {
    await this.ensureMainDepartments();
    return departmentRepository.findPaginated(
      { isActive: true },
      { page, limit, populate: { path: 'head', select: 'name avatarUrl jobTitle role' } }
    );
  }

  async getById(id) {
    const department = await departmentRepository.findById(id, {
      populate: { path: 'head', select: 'name avatarUrl jobTitle role' },
    });
    if (!department) throw ApiError.notFound('Department not found');
    return department;
  }

  async update(id, updates) {
    const department = await departmentRepository.updateById(id, updates);
    if (!department) throw ApiError.notFound('Department not found');
    return department;
  }

  async deactivate(id) {
    const department = await departmentRepository.updateById(id, { isActive: false });
    if (!department) throw ApiError.notFound('Department not found');
    return department;
  }
}

module.exports = new DepartmentService();
