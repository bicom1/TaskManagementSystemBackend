/**
 * Upsert a Super Admin without wiping the database.
 * Usage: node src/scripts/ensure-super-admin.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/user.model');
const { ROLES } = require('../constants/roles.constant');

const EMAIL = (process.env.SEED_SUPER_ADMIN_EMAIL || 'ibrahim@bicommunications.ae')
  .toLowerCase()
  .trim();
const PASSWORD = process.env.SEED_SUPER_ADMIN_PASSWORD || 'Ibrahim@Admin123';
const NAME = process.env.SEED_SUPER_ADMIN_NAME || 'Ibrahim';

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri || uri.includes('<db_password>')) {
    console.error('Set a real MONGO_URI in backend/.env before running.');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log('Connected. Ensuring Super Admin…');

  let user = await User.findOne({ email: EMAIL }).select('+password');

  if (user) {
    user.name = NAME;
    user.role = ROLES.SUPER_ADMIN;
    user.jobTitle = 'Super Admin';
    user.password = PASSWORD;
    user.markModified('password');
    user.isActive = true;
    user.invitePending = false;
    user.authProvider = 'local';
    await user.save();
    console.log(`Updated existing Super Admin: ${EMAIL}`);
  } else {
    user = await User.create({
      name: NAME,
      email: EMAIL,
      password: PASSWORD,
      role: ROLES.SUPER_ADMIN,
      jobTitle: 'Super Admin',
      authProvider: 'local',
      isActive: true,
      invitePending: false,
    });
    console.log(`Created Super Admin: ${EMAIL}`);
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
