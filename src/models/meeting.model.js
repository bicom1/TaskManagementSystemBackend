const mongoose = require('mongoose');

const meetingSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, trim: true, maxlength: 2000, default: '' },
    startsAt: { type: Date, required: true },
    endsAt: { type: Date, required: true },
    team: { type: mongoose.Schema.Types.ObjectId, ref: 'Team', default: null },
    department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', default: null },
    project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', default: null },
    location: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', default: null },
    locationLabel: { type: String, trim: true, maxlength: 200, default: '' },
    organizer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    attendees: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    meetingUrl: { type: String, trim: true, maxlength: 500, default: '' },
    isCancelled: { type: Boolean, default: false },
  },
  { timestamps: true }
);

meetingSchema.index({ startsAt: 1, team: 1 });
meetingSchema.index({ attendees: 1, startsAt: 1 });

module.exports = mongoose.model('Meeting', meetingSchema);
