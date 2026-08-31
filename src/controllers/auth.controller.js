const httpStatus = require('http-status-codes');
const authService = require('../services/auth.service');
const env = require('../config/env');
const { getClientBaseUrl } = require('../utils/clientUrl.util');

const REFRESH_COOKIE_NAME = 'refreshToken';
const GOOGLE_STATE_COOKIE = 'google_oauth_state';

// Cross-site (Vercel frontend → Render API) needs SameSite=None + Secure in production
const isProd = env.NODE_ENV === 'production';
const refreshCookieOptions = {
  httpOnly: true,
  secure: isProd,
  sameSite: isProd ? 'none' : 'lax',
  path: '/api/v1/auth',
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

function setRefreshCookie(res, token) {
  res.cookie(REFRESH_COOKIE_NAME, token, refreshCookieOptions);
}

function loginRedirect(res, accessToken, errorCode) {
  const base = getClientBaseUrl();
  if (errorCode) {
    return res.redirect(`${base}/login?googleError=${encodeURIComponent(errorCode)}`);
  }
  const url = new URL(`${base}/auth/google/callback`);
  url.searchParams.set('accessToken', accessToken);
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
  const state = authService.createOAuthState();
  res.cookie(GOOGLE_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: isProd ? 'none' : 'lax',
    secure: isProd,
    maxAge: 10 * 60 * 1000,
    path: '/api/v1/auth',
  });
  const url = authService.getGoogleAuthUrl(state);
  res.redirect(url);
}

/** Google redirects here with ?code= */
async function googleCallback(req, res) {
  try {
    const { code, state, error } = req.query;

    if (error) {
      return loginRedirect(res, null, String(error));
    }

    const savedState = req.cookies[GOOGLE_STATE_COOKIE];
    res.clearCookie(GOOGLE_STATE_COOKIE, { path: '/api/v1/auth' });

    if (!code || !state || !savedState || state !== savedState) {
      return loginRedirect(res, null, 'invalid_state');
    }

    const { accessToken, refreshToken } = await authService.googleAuthWithCode(String(code));
    setRefreshCookie(res, refreshToken);
    return loginRedirect(res, accessToken);
  } catch (err) {
    const message = err?.message || 'google_failed';
    return loginRedirect(res, null, message);
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
