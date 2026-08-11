const mongoose = require('mongoose');

const locationSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    address: { type: String, trim: true, maxlength: 300, default: '' },
    city: { type: String, trim: true, maxlength: 100, default: '' },
    type: {
      type: String,
      enum: ['office', 'remote', 'client', 'other'],
      default: 'office',
    },
    team: { type: mongoose.Schema.Types.ObjectId, ref: 'Team', default: null },
    department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

locationSchema.index({ team: 1, isActive: 1 });
locationSchema.index({ department: 1 });

module.exports = mongoose.model('Location', locationSchema);
