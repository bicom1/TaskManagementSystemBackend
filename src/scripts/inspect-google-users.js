/**
 * Inspect invite/Google status for specific emails.
 * Usage: node src/scripts/inspect-google-users.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/database');

const EMAILS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['maazkhan29456@gmail.com', 'devmaaz636@gmail.com'];

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

(async () => {
  await connectDB();
  const User = require('../models/user.model');

  for (const email of EMAILS) {
    const u = await User.findOne({
      email: { $regex: `^${escapeRegex(email)}$`, $options: 'i' },
    })
      .select('+password +inviteToken +inviteTokenExpires')
      .lean();

    if (!u) {
      console.log(JSON.stringify({ email, found: false }, null, 2));
      continue;
    }

    console.log(
      JSON.stringify(
        {
          email: u.email,
          found: true,
          id: String(u._id),
          role: u.role,
          authProvider: u.authProvider,
          invitePending: u.invitePending,
          isActive: u.isActive,
          hasGoogleId: Boolean(u.googleId),
          googleId: u.googleId || null,
          hasPassword: Boolean(u.password),
          hasInviteToken: Boolean(u.inviteToken),
          inviteTokenExpires: u.inviteTokenExpires || null,
          inviteExpired: u.inviteTokenExpires
            ? new Date(u.inviteTokenExpires) < new Date()
            : null,
          lastLoginAt: u.lastLoginAt || null,
          department: u.department ? String(u.department) : null,
          createdAt: u.createdAt,
          updatedAt: u.updatedAt,
        },
        null,
        2
      )
    );
  }

  // Also list any other users sharing googleId collisions or same local-part
  const invitees = await User.find({
    $or: [
      { email: /devmaaz636/i },
      { invitePending: true },
    ],
  })
    .select('email role invitePending authProvider googleId isActive lastLoginAt')
    .lean();

  console.log('\n--- pending / matching invitees ---');
  console.log(
    JSON.stringify(
      invitees.map((u) => ({
        email: u.email,
        role: u.role,
        invitePending: u.invitePending,
        authProvider: u.authProvider,
        hasGoogleId: Boolean(u.googleId),
        isActive: u.isActive,
        lastLoginAt: u.lastLoginAt || null,
      })),
      null,
      2
    )
  );

  await mongoose.disconnect();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
