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
const { clientPath } = require('../utils/clientUrl.util');

class AuthService {
  getGoogleRedirectUri() {
    const configured = String(env.GOOGLE_REDIRECT_URI || '').trim();
    const renderBase = String(process.env.RENDER_EXTERNAL_URL || '').trim().replace(/\/$/, '');

    // Never send localhost redirect to Google from production (causes redirect_uri_mismatch)
    if (env.NODE_ENV === 'production') {
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

  getGoogleAuthUrl(state) {
    const redirectUri = this.getGoogleRedirectUri();
    logger.info(`Google OAuth redirect_uri=${redirectUri}`);
    const client = this.#getGoogleClient(redirectUri);
    return client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'select_account',
      scope: ['openid', 'email', 'profile'],
      state,
      redirect_uri: redirectUri,
    });
  }

  async register({ name, email, password }) {
    const existing = await userRepository.existsByEmail(email);
    if (existing) {
      throw ApiError.conflict('An account with this email already exists');
    }

    const userCount = await userRepository.countAll();
    const role = userCount === 0 ? 'super_admin' : undefined;

    const user = await userRepository.create({
      name,
      email,
      password,
      authProvider: 'local',
      ...(role && { role, jobTitle: 'Super Admin' }),
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

    // Google-only accounts without a local password
    if (user.authProvider === 'google' && !user.password) {
      throw ApiError.unauthorized(
        'This account uses Google Sign-In. Please continue with Google.'
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

    if (user.invitePending) {
      await userRepository.updateById(user._id, { invitePending: false });
      user.invitePending = false;
    }

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

    const otp = String(crypto.randomInt(100000, 1000000));
    const hashedOtp = crypto.createHash('sha256').update(otp).digest('hex');

    user.passwordResetToken = hashedOtp;
    user.passwordResetExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
    await user.save({ validateBeforeSave: false });

    const resetUrl = clientPath(`/reset-password?email=${encodeURIComponent(user.email)}`);

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

  async googleAuthWithCode(code) {
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

    return this.#loginWithGoogleProfile(ticket.getPayload());
  }

  async #loginWithGoogleProfile(payload) {
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

    // 1) Already linked to this Google account
    let user = await userRepository.findByGoogleId(googleId);

    // Always refresh Google photo/name on sign-in when Google provides them
    if (user) {
      const refresh = {};
      if (avatarUrl) refresh.avatarUrl = avatarUrl;
      if (name && name !== user.name) refresh.name = name;
      if (Object.keys(refresh).length) {
        user = await userRepository.updateById(user._id, refresh);
      }
    }

    // 2) Same email already registered (password / invite) → link, do not create duplicate
    if (!user) {
      user = await userRepository.findByEmailInsensitive(email, { withPassword: true });
      if (user) {
        const updates = {
          googleId,
          invitePending: false,
        };
        if (avatarUrl) updates.avatarUrl = avatarUrl;
        // Keep local provider if they already have a password so email login still works
        if (user.password) {
          updates.authProvider = 'local';
        } else {
          updates.authProvider = 'google';
        }
        // Normalize email casing on the existing row
        if (user.email !== email) {
          updates.email = email;
        }
        try {
          user = await userRepository.updateById(user._id, updates);
        } catch (err) {
          // googleId already on another row — use that account instead of failing
          if (err?.code === 11000) {
            user = await userRepository.findByGoogleId(googleId);
            if (!user) {
              user = await userRepository.findByEmailInsensitive(email, { withPassword: true });
            }
            if (!user) throw err;
            if (avatarUrl) {
              user = await userRepository.updateById(user._id, { avatarUrl });
            }
          } else {
            throw err;
          }
        }
      }
    }

    // 3) Brand-new Google user
    if (!user) {
      try {
        const userCount = await userRepository.countAll();
        const role = userCount === 0 ? 'super_admin' : undefined;

        user = await userRepository.create({
          name,
          email,
          googleId,
          authProvider: 'google',
          avatarUrl,
          ...(role && { role, jobTitle: 'Super Admin' }),
        });
      } catch (err) {
        // Race / duplicate email or googleId → authenticate existing account
        if (err?.code === 11000) {
          user =
            (await userRepository.findByGoogleId(googleId)) ||
            (await userRepository.findByEmailInsensitive(email, { withPassword: true }));
          if (user) {
            const recover = { invitePending: false };
            if (!user.googleId) recover.googleId = googleId;
            if (avatarUrl) recover.avatarUrl = avatarUrl;
            user = await userRepository.updateById(user._id, recover);
          }
        }
        if (!user) {
          logger.error('Google sign-in failed after duplicate key', err);
          throw ApiError.badRequest(
            'Could not complete Google sign-in. Try email login or contact support.'
          );
        }
      }
    }

    if (!user?.isActive) {
      throw ApiError.unauthorized('Account is deactivated');
    }

    await userRepository.updateLastLogin(user._id);

    if (user.invitePending) {
      await userRepository.updateById(user._id, { invitePending: false });
      user.invitePending = false;
    }

    user = await userRepository.findById(user._id);
    const authTokens = this.#issueTokens(user);
    return { user: user.toSafeObject(), ...authTokens };
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

  createOAuthState() {
    return crypto.randomBytes(24).toString('hex');
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
