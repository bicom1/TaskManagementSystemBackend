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
  const User = mongoose.model('User');

  // 1) Members cannot use Google — the invite stays pending for the password form
  const memberEmail = `invite.google.member.${Date.now()}@example.com`;
  const memberInvite = await userService.invite(
    {
      email: memberEmail,
      name: 'Invite Google Member Smoke',
      role: ROLES.MEMBER,
      departmentName: 'Development',
    },
    actor
  );
  let memberErr = null;
  try {
    await authService.acceptInviteWithGoogleProfile({
      inviteToken: memberInvite.inviteToken,
      email: memberEmail,
      googleId: `smoke-google-${crypto.randomBytes(8).toString('hex')}`,
      name: 'Invite Google Member Smoke',
    });
  } catch (err) {
    memberErr = err;
  }
  if (memberErr?.reason !== 'google_superadmin_only') {
    throw new Error(`member Google accept should be rejected, got: ${memberErr?.message || 'success'}`);
  }
  const memberRow = await userRepository.findByEmailInsensitive(memberEmail);
  if (!memberRow?.invitePending || memberRow.googleId) {
    throw new Error('rejected member invite was modified');
  }
  await User.deleteOne({ _id: memberRow._id });

  // 2) Super Admin invitees may accept with Google
  const email = `invite.google.${Date.now()}@example.com`;
  const invited = await userService.invite(
    {
      email,
      name: 'Invite Google Smoke',
      role: ROLES.SUPERADMIN,
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

  await User.deleteOne({ _id: again._id });

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
