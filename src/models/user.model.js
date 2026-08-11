const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { ROLE_VALUES, ROLES } = require('../constants/roles.constant');

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
      maxlength: 100,
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, 'Invalid email format'],
    },
    password: {
      type: String,
      required: [
        function requiredPassword() {
          return this.authProvider !== 'google';
        },
        'Password is required',
      ],
      minlength: 8,
      select: false,
    },
    googleId: {
      type: String,
      unique: true,
      sparse: true,
    },
    authProvider: {
      type: String,
      enum: ['local', 'google'],
      default: 'local',
    },
    role: {
      type: String,
      enum: ROLE_VALUES,
      default: ROLES.EMPLOYEE,
    },
    jobTitle: {
      type: String,
      trim: true,
      maxlength: 100,
      default: null,
    },
    department: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Department',
      default: null,
    },
    avatarUrl: {
      type: String,
      default: null,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    tokenVersion: {
      type: Number,
      default: 0,
    },
    lastLoginAt: {
      type: Date,
      default: null,
    },
    invitePending: {
      type: Boolean,
      default: false,
    },
    invitedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    /** Hashed invite acceptance token (email/token workflow) */
    inviteToken: {
      type: String,
      select: false,
      default: null,
    },
    inviteTokenExpires: {
      type: Date,
      select: false,
      default: null,
    },
    deactivatedAt: {
      type: Date,
      default: null,
    },
    passwordResetToken: {
      type: String,
      select: false,
      default: null,
    },
    passwordResetExpires: {
      type: Date,
      select: false,
      default: null,
    },
    preferences: {
      homeCards: [
        {
          id: { type: String, required: true },
          enabled: { type: Boolean, default: true },
          order: { type: Number, default: 0 },
        },
      ],
      personalList: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Task' }],
      calendarProvider: {
        type: String,
        enum: ['none', 'google', 'outlook'],
        default: 'none',
      },
      recentItems: [
        {
          type: { type: String, enum: ['task', 'project'], required: true },
          refId: { type: mongoose.Schema.Types.ObjectId, required: true },
          title: { type: String, required: true },
          subtitle: { type: String, default: '' },
          projectId: { type: mongoose.Schema.Types.ObjectId, default: null },
          at: { type: Date, default: Date.now },
        },
      ],
    },
  },
  { timestamps: true }
);

userSchema.pre('save', async function hashPassword(next) {
  if (!this.isModified('password') || !this.password) return next();
  const salt = await bcrypt.genSalt(12);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

userSchema.methods.comparePassword = function comparePassword(candidate) {
  if (!this.password) return Promise.resolve(false);
  return bcrypt.compare(candidate, this.password);
};

userSchema.methods.toSafeObject = function toSafeObject() {
  const obj = this.toObject();
  delete obj.password;
  delete obj.passwordResetToken;
  delete obj.passwordResetExpires;
  delete obj.__v;
  return obj;
};

module.exports = mongoose.model('User', userSchema);
