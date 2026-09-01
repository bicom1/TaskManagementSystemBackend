const httpStatus = require('http-status-codes');
const authService = require('../services/auth.service');
const env = require('../config/env');
const {
  getClientBaseUrl,
  resolveClientUrlFromRequest,
  isAllowedClientOrigin,
  normalizeUrl,
} = require('../utils/clientUrl.util');

const REFRESH_COOKIE_NAME = 'refreshToken';
const GOOGLE_STATE_COOKIE = 'google_oauth_state';
const GOOGLE_CLIENT_URL_COOKIE = 'google_oauth_client_url';

// Cross-site (Vercel frontend → Render API) needs SameSite=None + Secure in production
const isProd = env.NODE_ENV === 'production';
const oauthCookieOptions = {
  httpOnly: true,
  secure: isProd,
  sameSite: isProd ? 'none' : 'lax',
  path: '/api/v1/auth',
};
const refreshCookieOptions = {
  ...oauthCookieOptions,
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

function setRefreshCookie(res, token) {
  res.cookie(REFRESH_COOKIE_NAME, token, refreshCookieOptions);
}

function resolveOAuthClientUrl(storedUrl) {
  if (storedUrl && isAllowedClientOrigin(storedUrl)) {
    return normalizeUrl(storedUrl);
  }
  return getClientBaseUrl();
}

function resolveGoogleErrorCode(err) {
  if (err?.statusCode === 403) {
    const msg = String(err.message || '');
    if (msg.includes('expired')) return 'invite_expired';
    return 'not_invited';
  }
  return err?.message || 'google_failed';
}

function loginRedirect(res, accessToken, errorCode, clientBase, user = null) {
  const base = resolveOAuthClientUrl(clientBase);
  if (errorCode) {
    return res.redirect(`${base}/login?googleError=${encodeURIComponent(errorCode)}`);
  }
  const url = new URL(`${base}/auth/google/callback`);
  url.searchParams.set('accessToken', accessToken);
  if (user) {
    const profile = Buffer.from(
      JSON.stringify({
        _id: user._id || user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        avatarUrl: user.avatarUrl ?? null,
        jobTitle: user.jobTitle ?? null,
      })
    ).toString('base64url');
    url.searchParams.set('profile', profile);
  }
  return res.redirect(url.toString());
}

async function register(req, res) {
  const { user, accessToken, refreshToken } = await authService.register(req.body);
  setRefreshCookie(res, refreshToken);
  res.status(httpStatus.StatusCodes.CREATED).json({
    success: true,
    message: 'Account created successfully',
    data: { user, accessToken },
  });
}

async function login(req, res) {
  const { user, accessToken, refreshToken } = await authService.login(req.body);
  setRefreshCookie(res, refreshToken);
  res.status(httpStatus.StatusCodes.OK).json({
    success: true,
    message: 'Logged in successfully',
    data: { user, accessToken },
  });
}

async function refresh(req, res) {
  const incomingToken = req.cookies[REFRESH_COOKIE_NAME];
  const { user, accessToken, refreshToken } = await authService.refresh(incomingToken);
  setRefreshCookie(res, refreshToken);
  res.status(httpStatus.StatusCodes.OK).json({
    success: true,
    message: 'Token refreshed',
    data: { user, accessToken },
  });
}

async function logout(req, res) {
  res.clearCookie(REFRESH_COOKIE_NAME, { path: '/api/v1/auth' });
  res.status(httpStatus.StatusCodes.OK).json({
    success: true,
    message: 'Logged out successfully',
  });
}

async function logoutAllDevices(req, res) {
  await authService.logoutAllDevices(req.user.id);
  res.clearCookie(REFRESH_COOKIE_NAME, { path: '/api/v1/auth' });
  res.status(httpStatus.StatusCodes.OK).json({
    success: true,
    message: 'Logged out from all devices',
  });
}

async function googleAuth(req, res) {
  const { user, accessToken, refreshToken } = await authService.googleAuth(req.body);
  setRefreshCookie(res, refreshToken);
  res.status(httpStatus.StatusCodes.OK).json({
    success: true,
    message: 'Signed in with Google',
    data: { user, accessToken },
  });
}

/** Redirect browser to Google consent screen */
async function googleStart(req, res) {
  const clientUrl = resolveClientUrlFromRequest(req);
  const state = authService.createOAuthState(clientUrl);

  // Cookie backup only — primary state is signed and returned by Google
  res.cookie(GOOGLE_STATE_COOKIE, state, {
    ...oauthCookieOptions,
    maxAge: 10 * 60 * 1000,
  });
  res.cookie(GOOGLE_CLIENT_URL_COOKIE, clientUrl, {
    ...oauthCookieOptions,
    maxAge: 10 * 60 * 1000,
  });

  const url = authService.getGoogleAuthUrl(state);
  res.redirect(url);
}

/** Google redirects here with ?code= */
async function googleCallback(req, res) {
  try {
    const { code, state, error } = req.query;

    if (error) {
      const savedClientUrl = req.cookies[GOOGLE_CLIENT_URL_COOKIE];
      res.clearCookie(GOOGLE_CLIENT_URL_COOKIE, { path: '/api/v1/auth' });
      return loginRedirect(res, null, String(error), savedClientUrl);
    }

    const verifiedState = authService.verifyOAuthState(state);
    const savedClientUrl =
      verifiedState?.clientUrl || req.cookies[GOOGLE_CLIENT_URL_COOKIE];
    res.clearCookie(GOOGLE_STATE_COOKIE, { path: '/api/v1/auth' });
    res.clearCookie(GOOGLE_CLIENT_URL_COOKIE, { path: '/api/v1/auth' });

    if (!code || !verifiedState) {
      return loginRedirect(res, null, 'invalid_state', savedClientUrl);
    }

    const auth = await authService.googleAuthWithCode(String(code));
    setRefreshCookie(res, auth.refreshToken);
    return loginRedirect(res, auth.accessToken, null, savedClientUrl, auth.user);
  } catch (err) {
    const message = resolveGoogleErrorCode(err);
    const savedClientUrl = req.cookies[GOOGLE_CLIENT_URL_COOKIE];
    res.clearCookie(GOOGLE_CLIENT_URL_COOKIE, { path: '/api/v1/auth' });
    return loginRedirect(res, null, message, savedClientUrl);
  }
}

async function forgotPassword(req, res) {
  const result = await authService.forgotPassword(req.body);
  res.status(httpStatus.StatusCodes.OK).json({
    success: true,
    message: result.message,
    data: {
      emailSent: result.emailSent,
      emailTo: result.emailTo,
      emailFrom: result.emailFrom,
      expiresInMinutes: result.expiresInMinutes,
    },
  });
}

async function resetPassword(req, res) {
  const result = await authService.resetPassword(req.body);
  res.status(httpStatus.StatusCodes.OK).json({
    success: true,
    message: result.message,
  });
}

module.exports = {
  register,
  login,
  refresh,
  logout,
  logoutAllDevices,
  googleAuth,
  googleStart,
  googleCallback,
  forgotPassword,
  resetPassword,
};
