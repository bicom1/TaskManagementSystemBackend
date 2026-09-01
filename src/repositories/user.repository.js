const User = require('../models/user.model');

class UserRepository {
  async create(data) {
    const user = new User(data);
    return user.save();
  }

  async findByEmail(email, { withPassword = false } = {}) {
    const normalized = String(email || '').toLowerCase().trim();
    const query = User.findOne({ email: normalized });
    if (withPassword) query.select('+password');
    return query.exec();
  }

  /** Case-insensitive email lookup (covers legacy mixed-case rows) */
  async findByEmailInsensitive(email, { withPassword = false } = {}) {
    const normalized = String(email || '').toLowerCase().trim();
    if (!normalized) return null;
    const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const query = User.findOne({
      email: { $regex: `^${escaped}$`, $options: 'i' },
    });
    if (withPassword) query.select('+password');
    return query.exec();
  }

  /** Case-insensitive email lookup including invite fields */
  async findByEmailInsensitiveWithInvite(email, { withPassword = false } = {}) {
    const normalized = String(email || '').toLowerCase().trim();
    if (!normalized) return null;
    const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const query = User.findOne({
      email: { $regex: `^${escaped}$`, $options: 'i' },
    }).select('+inviteToken +inviteTokenExpires');
    if (withPassword) query.select('+password');
    return query.exec();
  }

  async findByGoogleId(googleId) {
    return User.findOne({ googleId }).exec();
  }

  async findById(id, { withPassword = false } = {}) {
    const query = User.findById(id);
    if (withPassword) query.select('+password');
    return query.exec();
  }

  async existsByEmail(email) {
    return User.exists({ email });
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

  async updateById(id, updates) {
    return User.findByIdAndUpdate(id, updates, {
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
