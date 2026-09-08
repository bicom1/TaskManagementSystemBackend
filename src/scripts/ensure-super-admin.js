/**
 * Upsert Superadmin without wiping the database.
 * Credentials come from env only — never hardcode production passwords in source.
 *
 *   SEED_SUPER_ADMIN_EMAIL
 *   SEED_SUPER_ADMIN_PASSWORD
 *   SEED_SUPER_ADMIN_NAME
 *
 * Usage: node src/scripts/ensure-super-admin.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/user.model');
const { ROLES } = require('../constants/roles.constant');

const EMAIL = (
  process.env.SEED_SUPER_ADMIN_EMAIL ||
  process.env.SUPERADMIN_EMAIL ||
  'hamzaumar2033@gmail.com'
)
  .toLowerCase()
  .trim();
const PASSWORD = process.env.SEED_SUPER_ADMIN_PASSWORD || process.env.SUPERADMIN_PASSWORD;
const NAME = process.env.SEED_SUPER_ADMIN_NAME || process.env.SUPERADMIN_NAME || 'Hamza Umar';

async function main() {
  if (!PASSWORD || String(PASSWORD).length < 8) {
    console.error(
      'Set SEED_SUPER_ADMIN_PASSWORD (or SUPERADMIN_PASSWORD) in backend/.env — min 8 chars.'
    );
    process.exit(1);
  }

  const uri = process.env.MONGO_URI;
  if (!uri || uri.includes('<db_password>')) {
    console.error('Set a real MONGO_URI in backend/.env before running.');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log('Connected. Ensuring Superadmin…');

  let user = await User.findOne({
    email: new RegExp(`^${EMAIL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
  }).select('+password');

  if (user) {
    user.name = NAME;
    user.role = ROLES.SUPERADMIN;
    user.jobTitle = 'Superadmin';
    user.password = PASSWORD;
    user.markModified('password');
    user.isActive = true;
    user.invitePending = false;
    if (!user.authProvider) user.authProvider = 'local';
    await user.save();
    console.log(`Updated existing Superadmin: ${EMAIL}`);
  } else {
    user = await User.create({
      name: NAME,
      email: EMAIL,
      password: PASSWORD,
      role: ROLES.SUPERADMIN,
      jobTitle: 'Superadmin',
      authProvider: 'local',
      isActive: true,
      invitePending: false,
    });
    console.log(`Created Superadmin: ${EMAIL}`);
  }

  const fresh = await User.findById(user._id).select('+password');
  const ok = await fresh.comparePassword(PASSWORD);
  if (!ok) {
    throw new Error(`Password verify failed for ${EMAIL}`);
  }

  console.log({
    id: String(user._id),
    email: user.email,
    role: user.role,
    name: user.name,
  });

  await mongoose.disconnect();
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
