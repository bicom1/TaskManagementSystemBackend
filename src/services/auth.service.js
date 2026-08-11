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

class AuthService {
  getGoogleRedirectUri() {
    return (
      env.GOOGLE_REDIRECT_URI ||
      `http://localhost:${env.PORT}/api/v1/auth/google/callback`
    );
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
    const client = this.#getGoogleClient();
    return client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'select_account',
      scope: ['openid', 'email', 'profile'],
      state,
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
    const user = await userRepository.findByEmail(email, { withPassword: true });
    if (!user || !user.isActive) {
      throw ApiError.unauthorized('Invalid email or password');
    }

    if (user.authProvider === 'google' && !user.password) {
      throw ApiError.unauthorized(
        'This account uses Google Sign-In. Please continue with Google.'
      );
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      throw ApiError.unauthorized('Invalid email or password');
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

    const resetUrl = `${env.CLIENT_URL}/reset-password?email=${encodeURIComponent(user.email)}`;

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
    const client = this.#getGoogleClient();
    let tokens;
    try {
      const result = await client.getToken(code);
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
    const googleId = payload.sub;
    const name = payload.name || email.split('@')[0];
    const avatarUrl = payload.picture || null;

    let user = await userRepository.findByGoogleId(googleId);

    if (!user) {
      user = await userRepository.findByEmail(email);
      if (user) {
        user = await userRepository.updateById(user._id, {
          googleId,
          authProvider: user.password ? 'local' : 'google',
          avatarUrl: user.avatarUrl || avatarUrl,
          invitePending: false,
        });
      } else {
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
      }
    }

    if (!user.isActive) {
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
