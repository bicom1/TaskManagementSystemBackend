const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const userRepository = require('../repositories/user.repository');
const ApiError = require('../utils/ApiError.util');
const {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} = require('../utils/jwt.util');
const env = require('../config/env');
const { sendMail } = require('../emails/mailer.util');
const { passwordResetEmail } = require('../emails/templates');
const logger = require('../config/logger');
const { emailPath } = require('../utils/clientUrl.util');
const { ROLES } = require('../constants/roles.constant');

class AuthService {
  getGoogleRedirectUri() {
    const configured = String(env.GOOGLE_REDIRECT_URI || '').trim();
    const renderBase = String(process.env.RENDER_EXTERNAL_URL || '').trim().replace(/\/$/, '');

    // Never send localhost redirect to Google from production (causes redirect_uri_mismatch)
    if (env.NODE_ENV === 'production' || String(process.env.RENDER_EXTERNAL_URL || '').trim()) {
      if (configured && !/localhost|127\.0\.0\.1/i.test(configured)) {
        return configured;
      }
      if (renderBase) {
        return `${renderBase}/api/v1/auth/google/callback`;
      }
      return 'https://biworkspace-api.onrender.com/api/v1/auth/google/callback';
    }

    return configured || `http://localhost:${env.PORT}/api/v1/auth/google/callback`;
  }

  #getGoogleClient(redirectUri = this.getGoogleRedirectUri()) {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
      throw ApiError.badRequest('Google Sign-In is not configured on the server');
    }
    return new OAuth2Client(
      env.GOOGLE_CLIENT_ID,
      env.GOOGLE_CLIENT_SECRET,
      redirectUri
    );
  }

  getGoogleAuthUrl(state, { loginHint } = {}) {
    const redirectUri = this.getGoogleRedirectUri();
    logger.info(`Google OAuth redirect_uri=${redirectUri}`);
    const client = this.#getGoogleClient(redirectUri);
    const opts = {
      access_type: 'offline',
      prompt: 'select_account',
      scope: ['openid', 'email', 'profile'],
      state,
      redirect_uri: redirectUri,
    };
    const hint = String(loginHint || '')
      .trim()
      .toLowerCase();
    if (hint) opts.login_hint = hint;
    return client.generateAuthUrl(opts);
  }

  async register({ name, email, password }) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const normalizedName = String(name || '').trim();

    const existing = await userRepository.findByEmailInsensitive(normalizedEmail);
    if (existing) {
      throw ApiError.conflict(
        'This email is already registered. Please log in using your existing account.'
      );
    }

    const userCount = await userRepository.countAll();
    if (userCount > 0) {
      throw ApiError.forbidden(
        'Open registration is disabled. Ask your Super Admin for a workspace invitation.'
      );
    }

    const user = await userRepository.create({
      name: normalizedName,
      email: normalizedEmail,
      password,
      authProvider: 'local',
      role: ROLES.SUPERADMIN,
      jobTitle: 'Superadmin',
    });
    const tokens = this.#issueTokens(user);

    return { user: user.toSafeObject(), ...tokens };
  }

  async login({ email, password }) {
    const normalizedEmail = String(email || '').toLowerCase().trim();
    const user =
      (await userRepository.findByEmail(normalizedEmail, { withPassword: true })) ||
      (await userRepository.findByEmailInsensitive(normalizedEmail, { withPassword: true }));

    if (!user || !user.isActive) {
      throw ApiError.unauthorized('Invalid email or password');
    }

    // Google-only / invited accounts cannot use email+password
    if (user.authProvider === 'google' || user.invitePending) {
      throw ApiError.unauthorized(
        'This account uses Google Sign-In. Please continue with Google using your invited email.'
      );
    }

    if (!user.password) {
      throw ApiError.unauthorized('Invalid email or password');
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      throw ApiError.unauthorized('Invalid email or password');
    }

    // Ensure email/password accounts stay on local provider after a successful login
    if (user.authProvider !== 'local') {
      await userRepository.updateById(user._id, { authProvider: 'local' });
      user.authProvider = 'local';
    }

    await userRepository.updateLastLogin(user._id);

    const tokens = this.#issueTokens(user);

    return { user: user.toSafeObject(), ...tokens };
  }

  async forgotPassword({ email }) {
    const normalized = String(email).trim().toLowerCase();
    const user = await userRepository.findByEmail(normalized);

    // Always return a safe message when no account — avoid email enumeration
    if (!user || !user.isActive) {
      return {
        message:
          'If an account exists for that email, we sent a one-time code from BIWORKSPACE.',
        emailSent: false,
      };
    }

    if (user.authProvider === 'google' || user.invitePending) {
      return {
        message:
          'This account uses Google Sign-In. Use Continue with Google on the login page instead of resetting a password.',
        emailSent: false,
        googleOnly: true,
      };
    }

    const otp = String(crypto.randomInt(100000, 1000000));
    const hashedOtp = crypto.createHash('sha256').update(otp).digest('hex');

    user.passwordResetToken = hashedOtp;
    user.passwordResetExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
    await user.save({ validateBeforeSave: false });

    const resetUrl = emailPath(`/reset-password?email=${encodeURIComponent(user.email)}`);

    try {
      const mailResult = await sendMail({
        to: user.email,
        subject: 'Your BIWORKSPACE password reset code',
        html: passwordResetEmail({
          recipientName: user.name,
          otp,
          resetUrl,
        }),
        text: [
          `BIWORKSPACE password reset`,
          ``,
          `Hi ${user.name || 'there'},`,
          `Your one-time code is: ${otp}`,
          `It expires in 10 minutes.`,
          ``,
          `Enter this code on the reset password page, then set a new password and sign in.`,
          resetUrl,
        ].join('\n'),
      });

      if (mailResult?.logged) {
        throw new Error('SMTP is not configured');
      }

      logger.info(
        `Password reset OTP emailed to ${user.email} id=${mailResult?.messageId} accepted=${mailResult?.accepted}`
      );

      return {
        message: `We sent a one-time code from BIWORKSPACE to ${user.email}. Check inbox and spam.`,
        emailSent: true,
        emailTo: user.email,
        emailFrom: mailResult?.from || env.EMAIL_FROM,
        expiresInMinutes: 10,
      };
    } catch (err) {
      logger.error(`Password reset email failed for ${user.email}: ${err.message}`);
      user.passwordResetToken = undefined;
      user.passwordResetExpires = undefined;
      await user.save({ validateBeforeSave: false });
      throw ApiError.serviceUnavailable(
        'Could not send the reset email right now. Check SMTP settings and try again.'
      );
    }
  }

  async resetPassword({ token, otp, email, password }) {
    const code = String(otp || token || '').trim();
    if (!code) {
      throw ApiError.badRequest('OTP code is required');
    }

    const hashedToken = crypto.createHash('sha256').update(code).digest('hex');
    let user = await userRepository.findByPasswordResetToken(hashedToken);

    if (!user && email) {
      const User = require('../models/user.model');
      user = await User.findOne({
        email: String(email).trim().toLowerCase(),
        passwordResetToken: hashedToken,
        passwordResetExpires: { $gt: new Date() },
      }).select('+password +passwordResetToken +passwordResetExpires');
    }

    if (!user) {
      throw ApiError.badRequest('Invalid or expired OTP code. Request a new one.');
    }

    user.password = password;
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;
    user.invitePending = false;
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();

    return {
      message: 'Password reset successfully. You can sign in with your new password.',
    };
  }

  async googleAuth({ credential }) {
    const client = this.#getGoogleClient();
    let ticket;
    try {
      ticket = await client.verifyIdToken({
        idToken: credential,
        audience: env.GOOGLE_CLIENT_ID,
      });
    } catch {
      throw ApiError.unauthorized('Invalid Google credential');
    }

    const payload = ticket.getPayload();
    return this.#loginWithGoogleProfile(payload);
  }

  async googleAuthWithCode(code, { expectedEmail, inviteToken } = {}) {
    const redirectUri = this.getGoogleRedirectUri();
    const client = this.#getGoogleClient(redirectUri);
    let tokens;
    try {
      const result = await client.getToken({ code, redirect_uri: redirectUri });
      tokens = result.tokens;
    } catch (err) {
      throw ApiError.unauthorized(
        `Google authorization failed: ${err.message || 'invalid code'}`
      );
    }

    if (!tokens?.id_token) {
      throw ApiError.unauthorized('Google did not return an ID token');
    }

    let ticket;
    try {
      ticket = await client.verifyIdToken({
        idToken: tokens.id_token,
        audience: env.GOOGLE_CLIENT_ID,
      });
    } catch {
      throw ApiError.unauthorized('Invalid Google ID token');
    }

    return this.#loginWithGoogleProfile(ticket.getPayload(), {
      expectedEmail,
      inviteToken,
    });
  }

  #assertGoogleInviteValid(user) {
    if (!user?.invitePending) return;
    if (user.inviteTokenExpires && user.inviteTokenExpires < new Date()) {
      throw ApiError.forbidden(
        'Your invitation has expired. Ask your admin to send a new invite.'
      );
    }
  }

  async #linkGoogleAccount(user, { googleId, email, avatarUrl }) {
    const updates = {
      googleId,
      invitePending: false,
      authProvider: user.password ? 'local' : 'google',
    };
    if (avatarUrl) updates.avatarUrl = avatarUrl;
    if (user.email !== email) {
      updates.email = email;
    }
    try {
      return await userRepository.updateById(user._id, updates);
    } catch (err) {
      if (err?.code === 11000) {
        const recovered =
          (await userRepository.findByGoogleId(googleId)) ||
          (await userRepository.findByEmailInsensitiveWithInvite(email, { withPassword: true }));
        if (!recovered) throw err;
        const recover = { invitePending: false };
        if (!recovered.googleId) recover.googleId = googleId;
        if (avatarUrl) recover.avatarUrl = avatarUrl;
        return userRepository.updateById(recovered._id, recover);
      }
      throw err;
    }
  }

  /**
   * Activate an invited user via Google — atomic $set/$unset (no save validators).
   */
  async #linkGoogleAndAcceptInvite(user, { googleId, email, name, avatarUrl }) {
    this.#assertGoogleInviteValid(user);

    const invitedEmail = String(user.email || '')
      .trim()
      .toLowerCase();
    if (invitedEmail && invitedEmail !== email) {
      throw ApiError.forbidden(
        `wrong_google_email: Sign in with Google using ${invitedEmail} — the same email you were invited with.`
      );
    }

    const taken = await userRepository.findByGoogleId(googleId);
    if (taken && String(taken._id) !== String(user._id)) {
      throw ApiError.conflict(
        'This Google account is already linked to another BIWORKSPACE user. Use the Google account for the invited email.'
      );
    }

    const User = require('../models/user.model');
    const $set = {
      googleId,
      authProvider: 'google',
      invitePending: false,
      isActive: true,
      deactivatedAt: null,
    };
    if (avatarUrl) $set.avatarUrl = avatarUrl;
    if (name && String(name).trim()) $set.name = String(name).trim();

    let result;
    try {
      result = await User.updateOne(
        { _id: user._id },
        {
          $set,
          $unset: {
            password: 1,
            inviteToken: 1,
            inviteTokenExpires: 1,
          },
        }
      );
    } catch (err) {
      if (err?.code === 11000) {
        throw ApiError.conflict(
          'This Google account is already linked to another BIWORKSPACE user. Use the Google account for the invited email.'
        );
      }
      logger.error('Invite Google accept update failed', err);
      throw ApiError.badRequest(
        err?.message || 'Could not activate invite with Google. Please try again.'
      );
    }

    if (!result || (result.matchedCount === 0 && result.n === 0)) {
      throw ApiError.notFound('Invited user not found');
    }

    const doc = await User.findById(user._id);
    if (!doc) throw ApiError.notFound('Invited user not found after activate');
    logger.info(`Invite accepted via Google for ${doc.email} id=${doc._id}`);
    return doc;
  }

  async #loginWithGoogleProfile(payload, { expectedEmail, inviteToken } = {}) {
    if (!payload?.email || !payload?.sub) {
      throw ApiError.unauthorized('Google account is missing required profile data');
    }

    if (payload.email_verified === false) {
      throw ApiError.unauthorized('Google email is not verified');
    }

    const email = payload.email.toLowerCase().trim();
    const googleId = String(payload.sub);
    const name = payload.name || email.split('@')[0];

    // Prefer higher-res Google profile photo when available
    let avatarUrl = payload.picture || null;
    if (avatarUrl && typeof avatarUrl === 'string') {
      avatarUrl = avatarUrl.replace(/=s\d+-c\b/, '=s256-c');
      if (!/=s\d+/.test(avatarUrl) && avatarUrl.includes('googleusercontent.com')) {
        avatarUrl = `${avatarUrl}${avatarUrl.includes('?') ? '&' : '?'}sz=256`;
      }
    }

    // ── 0) Invite-token path (new invited users) ──────────────────────────
    // Soft-fail: if the token is stale/missing in DB, continue to email match
    // so a valid invited Gmail can still activate.
    const rawInvite = String(inviteToken || '').trim();
    if (rawInvite) {
      const inviteUser = await this.#findInviteUserByRawToken(rawInvite);
      if (inviteUser) {
        const invitedEmail = String(inviteUser.email || '')
          .trim()
          .toLowerCase();
        if (invitedEmail !== email) {
          throw ApiError.forbidden(
            `wrong_google_email: Sign in with Google using ${invitedEmail} — the same email you were invited with.`
          );
        }

        let activated = await this.#linkGoogleAndAcceptInvite(inviteUser, {
          googleId,
          email,
          name,
          avatarUrl,
        });
        await userRepository.updateLastLogin(activated._id);
        activated = await userRepository.findById(activated._id);
        const tokens = this.#issueTokens(activated);
        return { user: activated.toSafeObject(), ...tokens };
      }
      logger.warn(
        `Invite token present but not found/expired; falling back to email match for ${email}`
      );
    }

    const expected = String(expectedEmail || '')
      .trim()
      .toLowerCase();
    if (expected && expected !== email) {
      // Hint mismatch: still allow if this Google email has its own pending invite
      const pendingForEmail = await userRepository.findByEmailInsensitiveWithInvite(email, {
        withPassword: true,
      });
      if (!pendingForEmail?.invitePending) {
        throw ApiError.forbidden(
          `wrong_google_email: Sign in with Google using ${expected} — the same email you were invited with.`
        );
      }
    }

    // ── 1) Already linked to this Google account ──────────────────────────
    let user = await userRepository.findByGoogleId(googleId);

    if (user) {
      const refresh = {};
      if (avatarUrl) refresh.avatarUrl = avatarUrl;
      if (name && name !== user.name) refresh.name = name;
      if (Object.keys(refresh).length) {
        user = await userRepository.updateById(user._id, refresh);
      }
      if (user?.invitePending) {
        user = await this.#linkGoogleAndAcceptInvite(user, {
          googleId,
          email,
          name,
          avatarUrl,
        });
      }
    }

    // ── 2) Same email already registered (invited or existing) ────────────
    if (!user) {
      user = await userRepository.findByEmailInsensitiveWithInvite(email, {
        withPassword: true,
      });
      if (user) {
        if (user.invitePending) {
          user = await this.#linkGoogleAndAcceptInvite(user, {
            googleId,
            email,
            name,
            avatarUrl,
          });
        } else {
          user = await this.#linkGoogleAccount(user, { googleId, email, avatarUrl });
        }
      }
    }

    // ── 3) Brand-new Google user — invitation-only ────────────────────────
    if (!user) {
      try {
        const userCount = await userRepository.countAll();
        if (userCount === 0) {
          user = await userRepository.create({
            name,
            email,
            googleId,
            authProvider: 'google',
            avatarUrl,
            role: ROLES.SUPERADMIN,
            jobTitle: 'Superadmin',
          });
        } else {
          throw ApiError.forbidden('You are not invited to this workspace.');
        }
      } catch (err) {
        if (err instanceof ApiError) throw err;
        if (err?.code === 11000) {
          user =
            (await userRepository.findByGoogleId(googleId)) ||
            (await userRepository.findByEmailInsensitiveWithInvite(email, {
              withPassword: true,
            }));
          if (user) {
            if (user.invitePending) {
              user = await this.#linkGoogleAndAcceptInvite(user, {
                googleId,
                email,
                name,
                avatarUrl,
              });
            } else {
              const recover = {
                invitePending: false,
                authProvider: 'google',
                $unset: { inviteToken: 1, inviteTokenExpires: 1 },
              };
              if (!user.googleId) recover.googleId = googleId;
              if (avatarUrl) recover.avatarUrl = avatarUrl;
              user = await userRepository.updateById(user._id, recover);
            }
          }
        }
        if (!user) {
          logger.error('Google sign-in failed after duplicate key', err);
          throw ApiError.badRequest(
            'Could not complete Google sign-in. Open your invite link and choose Continue with Google.'
          );
        }
      }
    }

    if (!user?.isActive) {
      throw ApiError.unauthorized('Account is deactivated');
    }

    await userRepository.updateLastLogin(user._id);

    if (user.invitePending) {
      user = await this.#linkGoogleAndAcceptInvite(user, {
        googleId,
        email,
        name,
        avatarUrl,
      });
    }

    user = await userRepository.findById(user._id);
    const authTokens = this.#issueTokens(user);
    return { user: user.toSafeObject(), ...authTokens };
  }

  async #findInviteUserByRawToken(rawToken) {
    const token = String(rawToken || '').trim();
    if (token.length < 16) return null;
    const hashed = crypto.createHash('sha256').update(token).digest('hex');
    const User = require('../models/user.model');
    // Match by token+expiry. Do not require invitePending — preview can succeed
    // while a partial row still needs Google activation.
    return User.findOne({
      inviteToken: hashed,
      inviteTokenExpires: { $gt: new Date() },
    })
      .select('+password +inviteToken +inviteTokenExpires')
      .exec();
  }

  async refresh(refreshToken) {
    if (!refreshToken) {
      throw ApiError.unauthorized('Refresh token missing');
    }

    let decoded;
    try {
      decoded = verifyRefreshToken(refreshToken);
    } catch {
      throw ApiError.unauthorized('Invalid or expired refresh token');
    }

    const user = await userRepository.findById(decoded.id);
    if (!user || !user.isActive) {
      throw ApiError.unauthorized('Invalid refresh token');
    }

    if (decoded.tokenVersion !== user.tokenVersion) {
      throw ApiError.unauthorized('Refresh token has been revoked');
    }

    const tokens = this.#issueTokens(user);
    return { user: user.toSafeObject(), ...tokens };
  }

  async logoutAllDevices(userId) {
    await userRepository.incrementTokenVersion(userId);
  }

  createOAuthState(clientUrl, { loginHint, inviteToken } = {}) {
    const data = {
      n: crypto.randomBytes(16).toString('hex'),
      c: clientUrl || null,
      h: loginHint ? String(loginHint).trim().toLowerCase() : null,
      i: inviteToken ? String(inviteToken).trim() : null,
      t: Date.now(),
    };
    const payload = JSON.stringify(data);
    const sig = crypto.createHmac('sha256', env.COOKIE_SECRET).update(payload).digest('base64url');
    return Buffer.from(JSON.stringify({ p: payload, s: sig })).toString('base64url');
  }

  verifyOAuthState(state) {
    try {
      const { p, s } = JSON.parse(Buffer.from(String(state), 'base64url').toString('utf8'));
      const expected = crypto.createHmac('sha256', env.COOKIE_SECRET).update(p).digest('base64url');
      if (s !== expected) return null;
      const data = JSON.parse(p);
      if (Date.now() - data.t > 15 * 60 * 1000) return null;
      return {
        nonce: data.n,
        clientUrl: data.c,
        loginHint: data.h || null,
        inviteToken: data.i || null,
      };
    } catch {
      return null;
    }
  }

  /** Resolve invited email from raw invite token (for Google login_hint + email match). */
  async resolveInviteByToken(rawToken) {
    const user = await this.#findInviteUserByRawToken(rawToken);
    if (!user?.email) return null;
    return {
      email: String(user.email).toLowerCase().trim(),
      name: user.name || null,
      inviteToken: String(rawToken || '').trim(),
    };
  }

  /**
   * Smoke/tests only: activate an invite as if Google returned this profile.
   * Not exposed over HTTP.
   */
  async acceptInviteWithGoogleProfile({ inviteToken, email, googleId, name, avatarUrl }) {
    return this.#loginWithGoogleProfile(
      {
        email,
        email_verified: true,
        sub: String(googleId),
        name: name || email,
        picture: avatarUrl || null,
      },
      { inviteToken, expectedEmail: email }
    );
  }

  #issueTokens(user) {
    const accessToken = signAccessToken({ id: user._id.toString(), role: user.role });
    const refreshToken = signRefreshToken({
      id: user._id.toString(),
      tokenVersion: user.tokenVersion,
    });
    return { accessToken, refreshToken };
  }
}

module.exports = new AuthService();
