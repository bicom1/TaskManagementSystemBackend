/**
 * Remove soft-deleted user clones left by the old delete flow.
 * Usage: node src/scripts/purge-soft-deleted-users.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/database');

(async () => {
  await connectDB();
  const User = require('../models/user.model');
  const before = await User.countDocuments({
    email: { $regex: '^deleted_', $options: 'i' },
  });
  const result = await User.deleteMany({
    email: { $regex: '^deleted_', $options: 'i' },
  });
  console.log(
    JSON.stringify(
      {
        softDeletedBefore: before,
        deletedCount: result.deletedCount,
      },
      null,
      2
    )
  );
  await mongoose.disconnect();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
