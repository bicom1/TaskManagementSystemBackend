const User = require('../models/user.model');

function normalizeEmail(email) {
  return String(email || '').toLowerCase().trim();
}

function emailRegexFilter(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return { $regex: `^${escaped}$`, $options: 'i' };
}

class UserRepository {
  async create(data) {
    const payload = { ...data };
    if (payload.email) payload.email = normalizeEmail(payload.email);
    if (payload.name) payload.name = String(payload.name).trim();
    const user = new User(payload);
    return user.save();
  }

  async findByEmail(email, { withPassword = false } = {}) {
    const normalized = normalizeEmail(email);
    const query = User.findOne({ email: normalized });
    if (withPassword) query.select('+password');
    return query.exec();
  }

  /** Case-insensitive email lookup (covers legacy mixed-case rows) */
  async findByEmailInsensitive(email, { withPassword = false } = {}) {
    const filter = emailRegexFilter(email);
    if (!filter) return null;
    const query = User.findOne({ email: filter });
    if (withPassword) query.select('+password');
    return query.exec();
  }

  /** Case-insensitive email lookup including invite fields */
  async findByEmailInsensitiveWithInvite(email, { withPassword = false } = {}) {
    const filter = emailRegexFilter(email);
    if (!filter) return null;
    const query = User.findOne({ email: filter }).select('+inviteToken +inviteTokenExpires');
    if (withPassword) query.select('+password');
    return query.exec();
  }

  async findByGoogleId(googleId) {
    if (!googleId) return null;
    // Prefer an active account. Soft-deleted rows must not block re-invites.
    const active = await User.findOne({
      googleId,
      isActive: { $ne: false },
      email: { $not: { $regex: '^deleted_', $options: 'i' } },
    }).exec();
    if (active) return active;
    return null;
  }

  async findById(id, { withPassword = false } = {}) {
    const query = User.findById(id);
    if (withPassword) query.select('+password');
    return query.exec();
  }

  async existsByEmail(email) {
    const filter = emailRegexFilter(email);
    if (!filter) return null;
    return User.exists({ email: filter });
  }

  async countAll() {
    return User.countDocuments();
  }

  async incrementTokenVersion(id) {
    return User.findByIdAndUpdate(
      id,
      { $inc: { tokenVersion: 1 } },
      { new: true }
    ).exec();
  }

  async updateLastLogin(id) {
    return User.findByIdAndUpdate(id, { lastLoginAt: new Date() }).exec();
  }

  async deleteById(id) {
    return User.findByIdAndDelete(id).exec();
  }

  /** Remove soft-deleted clones for an email so re-invite is a clean Google onboarding. */
  async purgeSoftDeletedForEmail(email) {
    const normalized = normalizeEmail(email);
    if (!normalized) return { deletedCount: 0 };
    const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const result = await User.deleteMany({
      email: { $regex: `^deleted_\\d+_.*${escaped}$`, $options: 'i' },
    }).exec();
    return { deletedCount: result?.deletedCount || 0 };
  }

  async updateById(id, updates) {
    const payload = { ...updates };
    const unset = { ...(payload.$unset || {}) };
    delete payload.$unset;

    if (Object.prototype.hasOwnProperty.call(updates, 'password') && updates.password == null) {
      delete payload.password;
      unset.password = 1;
    }

    const hasUnset = Object.keys(unset).length > 0;
    const hasSet = Object.keys(payload).length > 0;

    if (hasUnset) {
      const ops = {};
      if (hasSet) ops.$set = payload;
      ops.$unset = unset;
      return User.findByIdAndUpdate(id, ops, {
        new: true,
        runValidators: true,
      }).exec();
    }

    return User.findByIdAndUpdate(id, payload, {
      new: true,
      runValidators: true,
    }).exec();
  }

  async findByPasswordResetToken(hashedToken) {
    return User.findOne({
      passwordResetToken: hashedToken,
      passwordResetExpires: { $gt: new Date() },
    })
      .select('+password +passwordResetToken +passwordResetExpires')
      .exec();
  }

  async findPaginated(filter = {}, { page = 1, limit = 50 } = {}) {
    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      User.find(filter)
        .select('-password')
        .populate('department', 'name code')
        .sort({ name: 1 })
        .skip(skip)
        .limit(limit)
        .lean()
        .exec(),
      User.countDocuments(filter),
    ]);
    return {
      data,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
      },
    };
  }
}

module.exports = new UserRepository();
