const mongoose = require('mongoose');
const { normalizeDepartmentCode } = require('../constants/roles.constant');

const departmentSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, unique: true, maxlength: 100 },
    /** Unique slug — built-in: seo | development | designing; custom codes allowed */
    code: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      maxlength: 50,
      match: [/^[a-z0-9][a-z0-9_-]*$/, 'Invalid department code'],
    },
    description: { type: String, trim: true, maxlength: 500 },
    head: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

departmentSchema.pre('validate', function normalizeCode(next) {
  if (this.code) this.code = normalizeDepartmentCode(this.code);
  next();
});

module.exports = mongoose.model('Department', departmentSchema);
