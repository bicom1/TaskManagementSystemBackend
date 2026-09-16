/**
 * Smoke: invite user → simulate Google profile accept (no real Google OAuth).
 * Usage (from backend/): node src/scripts/smoke-invite-google.js
 */
require('dotenv').config();
const crypto = require('crypto');
const mongoose = require('mongoose');
const connectDB = require('../config/database');
const authService = require('../services/auth.service');
const userService = require('../services/user.service');
const userRepository = require('../repositories/user.repository');
const policy = require('../services/policy.service');
const { ROLES } = require('../constants/roles.constant');

async function main() {
  await connectDB();

  const adminEmail =
    process.env.SMOKE_EMAIL ||
    process.env.SEED_SUPER_ADMIN_EMAIL ||
    'ibrahim@bicommunications.ae';

  const admin = await userRepository.findByEmailInsensitive(adminEmail);
  if (!admin) throw new Error(`Admin not found: ${adminEmail}`);

  const actor = await policy.buildActorContext(admin._id);
  const email = `invite.google.${Date.now()}@example.com`;

  const invited = await userService.invite(
    {
      email,
      name: 'Invite Google Smoke',
      role: ROLES.MEMBER,
      departmentName: 'Development',
    },
    actor
  );

  const inviteToken = invited.inviteToken;
  if (!inviteToken) throw new Error('inviteToken missing from invite response');

  const preview = await userService.previewInvite(inviteToken);
  if (String(preview.email).toLowerCase() !== email) {
    throw new Error('preview email mismatch');
  }

  const fakeGoogleId = `smoke-google-${crypto.randomBytes(8).toString('hex')}`;
  const login = await authService.acceptInviteWithGoogleProfile({
    inviteToken,
    email,
    googleId: fakeGoogleId,
    name: 'Invite Google Smoke',
  });

  if (!login?.user?.email || String(login.user.email).toLowerCase() !== email) {
    throw new Error('Google accept did not return invited user');
  }
  if (login.user.invitePending) throw new Error('invitePending still true after Google accept');
  if (!login.accessToken) throw new Error('missing accessToken');

  const again = await userRepository.findByEmailInsensitive(email);
  if (again.invitePending) throw new Error('DB invitePending still true');
  if (String(again.googleId) !== fakeGoogleId) throw new Error('googleId not linked');

  await mongoose.model('User').deleteOne({ _id: again._id });

  console.log('INVITE_GOOGLE_OK', email);
  await mongoose.disconnect();
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
