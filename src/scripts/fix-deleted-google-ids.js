/**
 * Clear googleId from soft-deleted users so re-invites can link Google again.
 * Usage: node src/scripts/fix-deleted-google-ids.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/database');

(async () => {
  await connectDB();
  const User = require('../models/user.model');

  const filter = {
    $or: [
      { email: { $regex: '^deleted_', $options: 'i' } },
      { isActive: false },
    ],
    googleId: { $exists: true, $nin: [null, ''] },
  };

  const before = await User.find(filter).select('email googleId isActive').lean();
  console.log('Found soft-deleted/inactive users with googleId:', before.length);
  for (const u of before) {
    console.log('-', u.email, u.googleId);
  }

  const result = await User.updateMany(filter, {
    $unset: { googleId: 1, inviteToken: 1, inviteTokenExpires: 1 },
  });

  console.log('Cleared googleId on matchedCount=', result.matchedCount, 'modified=', result.modifiedCount);
  await mongoose.disconnect();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
